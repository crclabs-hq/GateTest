function createSession(user, token) {
  // PLANTED #11: sensitive session token written straight to logs.
  console.log('session created, token:', token);
  return { user, token, createdAt: Date.now() };
}

module.exports = { createSession };
