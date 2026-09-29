/**
 * Offset → line/column, for findings raised by a regex over a whole file.
 *
 * One definition (Doctrine §4). A module that runs `/<input\b/g` over the
 * file text knows the match OFFSET, and a finding without a line cannot be
 * annotated inline or fixed surgically (issue #842 DR-b: 1,534 accessibility
 * findings on DavenRoe, every one `line: null`). Lines and columns are
 * 1-based, the way an editor and the JSON report show them.
 *
 * `lineLocator(content)` indexes the line starts once and answers every
 * offset in O(log n) — the shape a per-file match loop wants. `lineAt` is
 * the one-shot form.
 */

function lineLocator(content) {
  const text = typeof content === 'string' ? content : '';
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return (offset) => {
    const at = Math.max(0, Math.min(Number(offset) || 0, text.length));
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: at - starts[lo] + 1 };
  };
}

function lineAt(content, offset) {
  return lineLocator(content)(offset);
}

module.exports = { lineLocator, lineAt };
