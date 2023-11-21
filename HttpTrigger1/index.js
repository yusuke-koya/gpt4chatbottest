module.exports = async function (context, req) {
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
      body: body//.challenge, // body: body にした方が良くないか
    };
    return;
  }


  context.res = {
    status: 200,
  };
};
