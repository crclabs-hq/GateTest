const https = require('https');

// PLANTED #5: TLS certificate verification disabled.
function fetchUpstream(path) {
  const options = {
    hostname: 'upstream.internal',
    path,
    method: 'GET',
    rejectUnauthorized: false,
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => resolve(res));
    req.on('error', reject);
    req.end();
  });
}

module.exports = { fetchUpstream };
