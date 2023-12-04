const { BlobServiceClient } = require("@azure/storage-blob");
const { WebClient } = require("@slack/web-api");
const {
  ChatCompletionRequestMessageRoleEnum,
  Configuration,
  OpenAIApi,
} = require("openai");

const openaiClient = new OpenAIApi(
  new Configuration({
    apiKey: process.env.OPENAI_API_KEY,
    basePath: process.env.OPENAI_API_URL + 'openai/deployments/' + process.env.OPENAI_DEPLOY_NAME,
    baseOptions: {
      headers: {'api-key': process.env.OPENAI_API_KEY},
      params: {
        'api-version': '2023-03-15-preview'
      }
    }
  })
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
    const response = await openaiClient.createChatCompletion({
      messages: messages,
      max_tokens: 800,
      temperature: 0.7,
      frequency_penalty: 0,
      presence_penalty: 0,
      top_p: 0.95,
    });
    return response.data.choices[0].message.content;
  } catch (err) {
    context.log.error(err);
    return err.response.statusText;
  }
};

module.exports = async function (context, req) {
  const { OpenAIClient } = require("@azure/openai");
  const { DefaultAzureCredential } = require("@azure/identity");
  const client = new OpenAIClient(
    "https://exa-dpf.openai.azure.com/", //ここにエンドポイント
    new DefaultAzureCredential()
  );

  const messages = [
    { role: "system", content: "You are an AI assistant." },
    { role: "user", content: "Hello" },
  ];

  const result = await client.getChatCompletions("gpt-35-turbo", messages); //ここにモデル名
  let message;
  for (const choice of result.choices) {
    message = choice.message;
  }

  context.log("message : " + message);
  context.res = {
    status: 200,
    body: { message: message },
    headers: {
      "Content-Type": "application/json",
    },
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
