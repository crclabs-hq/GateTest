// PLANTED #7: ReDoS — catastrophic backtracking pattern (nested quantifiers,
// classic (X+)+ shape).
const EMAIL_LOCAL_PART = /^([a-zA-Z0-9]+)+@/;

function looksLikeEmail(value) {
  return EMAIL_LOCAL_PART.test(value);
}

module.exports = { looksLikeEmail };
