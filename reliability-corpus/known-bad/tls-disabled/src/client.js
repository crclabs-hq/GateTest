"use strict";

const https = require("https");

// BAD: disables TLS cert validation for all requests using this agent.
const agent = new https.Agent({ rejectUnauthorized: false });

function fetchUpstream(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { agent }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

module.exports = { fetchUpstream };
