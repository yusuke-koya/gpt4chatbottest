const { BlobServiceClient } = require("@azure/storage-blob");
const { WebClient } = require("@slack/web-api");
const { ChatCompletionRequestMessageRoleEnum } = require("openai");
const { OpenAIClient } = require("@azure/openai");
const { DefaultAzureCredential } = require("@azure/identity");
const client = new OpenAIClient(
  process.env.OPENAI_API_URL, //ここにエンドポイント
  new DefaultAzureCredential()
);

const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
const CHAT_GPT_SYSTEM_PROMPT = process.env.CHAT_GPT_SYSTEM_PROMPT;
const GPT_THREAD_MAX_COUNT = process.env.GPT_THREAD_MAX_COUNT;

/**
 * Slackへメッセージを投稿する
 * @param {string} channel 投稿先のチャンネル
 * @param {string} text 投稿するメッセージ
 * @param {string} threadTs 投稿先がスレッドの場合の設定
 * @param {object} context Azure Functions のcontext
 */
const postMessage = async (channel, text, threadTs, context) => {
  context.log('reply:' + text);
  await slackClient.chat.postMessage({
    channel: channel,
    text: text,
    thread_ts: threadTs,
  });
};

/**
 * ChatGPTからメッセージを受け取る
 * @param {string} messages 尋ねるメッセージ
 * @param {object} context Azure Functions のcontext
 * @returns content
 */
const createCompletion = async (messages, context) => {
  try {
    const result = await client.getChatCompletions(process.env.OPENAI_DEPLOY_NAME, messages, {
      maxTokens: 800,
      temperature: 0.7,
      frequencyPenalty: 0,
      presencePenalty: 0,
      topP: 0.95,
    });

    return result.choices[0].message.content;
  } catch (err) {
    context.log.error(err);
    return err.response.statusText;
  }
};

module.exports = async function (context, req) {
  // Ignore retry requests
  if (req.headers["x-slack-retry-num"]) {
    context.log("Ignoring Retry request: " + req.headers["x-slack-retry-num"]);
    context.log(req.body);
    return {
      statusCode: 200,
      body: JSON.stringify({ message: "No need to resend" }),
    };
  }

  // Response slack challenge requests
  const body = eval(req.body);
  if (body.challenge) {
    context.log("Challenge: " + body.challenge);
    context.res = {
      body: body//.challenge
    };
    return;
  }

//   context.log(`user:${body.event.user}, message:${body.event.text}`); // 投稿したユーザのIDとテキスト
//   context.log.warn('警告');
//   context.log.error('エラー');

  const event = body.event;
  const threadTs = event?.thread_ts ?? event?.ts;
  if (event?.type === "app_mention") {
    try {
      // ユーザIDからメールアドレスを取得する
      const userEmailResponse = await slackClient.users.info({
        user: event.user,
      });
      context.log(`user:${userEmailResponse.user.profile.email}, message:${body.event.text}`); // 投稿したユーザのメールアドレスとテキスト

      // 許可されたユーザでない場合はメッセージを表示して終了する
      const isAllowed = await isAllowedUser(userEmailResponse.user.profile.email);
      if(!isAllowed) {
        await postMessage(
          event.channel,
          "あなたの利用は許可されていません。",
          threadTs,
          context
        );
        return;
      }

      // NGワードが含まれていたらメッセージを表示して終了する
      const ngText = await hasNgWord(event?.text);
      if(ngText) {
        await postMessage(
          event.channel,
          "不適切な言葉が含まれています。",
          threadTs,
          context
        );
        return;
      }

      // スレッドの投稿を取得する
      const threadMessagesResponse = await slackClient.conversations.replies({
        channel: event.channel,
        ts: threadTs,
      });
      if (threadMessagesResponse.ok !== true) {
        await postMessage(
          event.channel,
          "[Bot]メッセージの取得に失敗しました。",
          threadTs,
          context
        );
        return;
      }
      const botMessages = threadMessagesResponse.messages
        .sort((a, b) => Number(a.ts) - Number(b.ts))
        .slice(GPT_THREAD_MAX_COUNT * -1)
        .map((m) => {
          const role = m.bot_id
            ? ChatCompletionRequestMessageRoleEnum.Assistant
            : ChatCompletionRequestMessageRoleEnum.User;
            // context.log(m.text);
          return { role: role, content: m.text.replace(/]+>/g, "") };
        });
      if (botMessages.length < 1) {
        await postMessage(
          event.channel,
          "[Bot]質問メッセージが見つかりませんでした。@gpt4chatbot を付けて質問してみて下さい。",
          threadTs,
          context
        );
        return;
      }
      context.log(botMessages);
      var postMessages = [
        {
          role: ChatCompletionRequestMessageRoleEnum.System,
          content: CHAT_GPT_SYSTEM_PROMPT,
        },
        ...botMessages,
      ];
      const openaiResponse = await createCompletion(postMessages, context);
      if (openaiResponse == null || openaiResponse == "") {
        await postMessage(
          event.channel,
          "[Bot]ChatGPTから返信がありませんでした。この症状は、ChatGPTのサーバーの調子が悪い時に起こります。少し待って再度試してみて下さい。",
          threadTs,
          context
        );
        return { statusCode: 200 };
      }
      await postMessage(event.channel, openaiResponse, threadTs, context);
      return { statusCode: 200 };
    } catch (error) {
      context.log(
        await postMessage(
          event.channel,
          `Error happened: ${error}`,
          threadTs,
          context
        )
      );
    }
  }
  context.res = {
    status: 200,
  };
};

// NGワードが含まれるか
async function hasNgWord(text) {
  try {
    const ngWordStr = await downloadBlobString(process.env.AZURE_STORAGE_CONNECTION_STRING, 'ngwordcontainer', 'ngwords.txt');
    const ngWordArray = ngWordStr.split('\n');
    for(let i in ngWordArray) {
      regex = new RegExp(ngWordArray[i].trim(), 'i');
      if(ngWordArray[i].trim() && regex.test(text)) {
        return true;
      }
    }
    return false;
  } catch (err) {
    console.error(`Error: ${err.message}`);
  }
}

// 許可されたユーザか
async function isAllowedUser(email) {
  try {
    const usersStr = await downloadBlobString(process.env.AZURE_STORAGE_CONNECTION_STRING, 'allowedusercontainer', 'users.txt');
    if(usersStr.indexOf(email) != -1) {
        return true;
    }else{
        return false;
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
  }
}

// Blob Storage にあるテキストファイルの文字列を取得する
async function downloadBlobString(connectionString, containerName, fileName) {
  try {
    // Create the BlobServiceClient object with connection string
    const blobServiceClient = BlobServiceClient.fromConnectionString(
        connectionString
    );

    // Get a reference to a container
    const containerClient = blobServiceClient.getContainerClient(containerName);

    const retStr = await downloadBlobToString(containerClient, fileName);
    return retStr;

    async function downloadBlobToString(containerClient, blobName) {
        const blobClient = containerClient.getBlobClient(blobName);
        const downloadResponse = await blobClient.download();
        const downloaded = await streamToBuffer(downloadResponse.readableStreamBody);
        return downloaded.toString();
    }

    async function streamToBuffer(readableStream) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            readableStream.on('data', (data) => {
                chunks.push(data instanceof Buffer ? data : Buffer.from(data));
            });
            readableStream.on('end', () => {
                resolve(Buffer.concat(chunks));
            });
            readableStream.on('error', reject);
        });
    }

  } catch (err) {
    console.error(`Error: ${err.message}`);
  }
}
