'use strict';

/* global document, window */ // this function runs in the page (page.evaluate), not in Node

/**
 * Text cut off at the right edge of the viewport WITHOUT the page scrolling
 * sideways — the overflow is hidden by a container (`overflow: hidden` on a
 * wrapper, or `overflow-x: clip` on html/body), so scrollWidth equals the
 * viewport and a scroll-only check passes while words are lost. Tallrig
 * /about at 375px (2026-10-03): "vendors" cut off, scrollWidth 375.
 *
 * This function is serialized into the page (page.evaluate), so it must be
 * self-contained — no closures over module scope. One definition, used by
 * mobileRendering.
 *
 * A clipped element is a visible element with its own text that STARTS on
 * screen and ENDS past the right edge. Not counted:
 *   - anything inside a horizontally scrollable container (code blocks, wide
 *     tables, carousels — the user can scroll to the rest);
 *   - elements that start off-screen (off-canvas menus, slides parked right);
 *   - screen-reader-only text (1px clip boxes) and invisible elements.
 */
function findClippedText(viewportWidth) {
  const vw = viewportWidth || document.documentElement.clientWidth;
  const out = [];
  const scrollsX = (el) => {
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const ox = window.getComputedStyle(a).overflowX;
      if ((ox === 'auto' || ox === 'scroll') && a.scrollWidth > a.clientWidth) return true;
    }
    return false;
  };
  for (const el of document.querySelectorAll('body *')) {
    if (out.length >= 5) break;
    const hasOwnText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length >= 2);
    if (!hasOwnText) continue;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    if (style.textOverflow === 'ellipsis') continue; // truncation the author chose
    const r = el.getBoundingClientRect();
    if (r.width <= 2 || r.height <= 2) continue; // sr-only / collapsed
    if (r.left >= vw - 1 || r.right <= vw + 2) continue; // starts off-screen, or fits
    if (scrollsX(el)) continue;
    out.push({ tag: el.tagName.toLowerCase(), text: el.textContent.trim().replace(/\s+/g, ' ').slice(0, 40), rightPx: Math.round(r.right), viewport: vw });
  }
  return out;
}

module.exports = { findClippedText };
