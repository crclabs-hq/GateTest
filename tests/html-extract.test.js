'use strict';

// src/core/html-extract.js — the one definition of "what is this page's
// <title>" and "what is this page's meta description" (#653, building on
// #641/#646). Both accept attributes in any order, whitespace/newlines
// inside the tag, and case-insensitive tags; a <title> nested inside
// <svg>...</svg> is ignored. src/modules/seo.js, the live-crawler and the
// website's quick URL scan (website/app/lib/html-extract.ts, a documented
// duplicate — Turbopack cannot bundle across the website/src boundary) all
// read through this module or its duplicate.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  extractTitle,
  extractMetaDescription,
  matchTitleTag,
  matchMetaDescriptionTag,
} = require('../src/core/html-extract');

describe('extractTitle / matchTitleTag', () => {
  it('CONTROL — a title with a single attribute is read correctly', () => {
    assert.equal(extractTitle('<title lang="en">Home</title>'), 'Home');
  });

  it('CONTROL — a title with multiple attributes in any order is read correctly', () => {
    assert.equal(extractTitle('<title data-sm="1" lang="en" class="x">Home</title>'), 'Home');
    assert.equal(extractTitle('<title class="x" data-sm="1">Deploy — Tallrig</title>'), 'Deploy — Tallrig');
  });

  it('CONTROL — a multi-line title (newlines inside the tag and around the text) is read correctly', () => {
    assert.equal(extractTitle('<title\n  lang="en"\n>\n  Home\n</title>'), 'Home');
    assert.equal(extractTitle('<title>\nHome\n</title>'), 'Home');
  });

  it('CONTROL — the tag name is matched case-insensitively', () => {
    assert.equal(extractTitle('<TITLE LANG="en">Home</TITLE>'), 'Home');
  });

  it('POSITIVE CONTROL — a <title> that exists only inside <svg>...</svg> still counts as missing', () => {
    assert.equal(extractTitle('<svg viewBox="0 0 10 10"><title>Icon</title></svg>'), null);
    assert.equal(matchTitleTag('<svg viewBox="0 0 10 10"><title>Icon</title></svg>'), undefined);
  });

  it('a real document title is still found alongside an svg icon title', () => {
    assert.equal(
      extractTitle('<title>Home</title><svg><title>Icon</title></svg>'),
      'Home',
    );
  });

  it('POSITIVE CONTROL — an empty or whitespace-only title counts as missing via extractTitle()', () => {
    assert.equal(extractTitle('<title></title>'), null);
    assert.equal(extractTitle('<title lang="en">   </title>'), null);
  });

  it('POSITIVE CONTROL — no <title> tag at all counts as missing', () => {
    assert.equal(extractTitle('<html><head></head><body>hi</body></html>'), null);
  });

  it('matchTitleTag() distinguishes "no tag" (undefined) from "tag present but empty" (empty string)', () => {
    assert.equal(matchTitleTag('<html><head></head></html>'), undefined);
    assert.equal(matchTitleTag('<title></title>').trim(), '');
    assert.equal(matchTitleTag('<title lang="en">Home</title>'), 'Home');
  });
});

describe('extractMetaDescription / matchMetaDescriptionTag', () => {
  it('CONTROL — name then content is read correctly', () => {
    assert.equal(extractMetaDescription('<meta name="description" content="A page.">'), 'A page.');
  });

  it('CONTROL — content then name (reversed order) is read correctly', () => {
    assert.equal(extractMetaDescription('<meta content="A page." name="description">'), 'A page.');
  });

  it('CONTROL — an attribute BETWEEN name and content, either order, is read correctly', () => {
    assert.equal(
      extractMetaDescription('<meta name="description" lang="en" content="A page.">'),
      'A page.',
    );
    assert.equal(
      extractMetaDescription('<meta content="A page." lang="en" name="description">'),
      'A page.',
    );
  });

  it('does not pair a name="description" on one <meta> tag with content= on a different tag', () => {
    assert.equal(
      matchMetaDescriptionTag('<meta name="description"><meta content="Unrelated.">'),
      undefined,
    );
  });

  it('POSITIVE CONTROL — no meta description tag at all returns null / undefined', () => {
    assert.equal(extractMetaDescription('<meta charset="utf-8">'), null);
    assert.equal(matchMetaDescriptionTag('<meta charset="utf-8">'), undefined);
  });

  it('a present-but-empty content="" is distinguishable from missing', () => {
    assert.equal(matchMetaDescriptionTag('<meta name="description" content="">'), '');
    assert.equal(extractMetaDescription('<meta name="description" content="">'), '');
  });
});
