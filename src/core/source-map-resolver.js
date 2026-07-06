'use strict';

/**
 * Source-map resolver — turns a minified/bundled stack-trace location
 * (dist/app.js:1:48213) back into the original source location
 * (src/components/Foo.tsx:42:7) so a fix loop gets an exact file:line
 * instead of a bundle offset.
 *
 * Zero-dependency Source Map V3 decoder (Base64 VLQ per the spec at
 * https://sourcemaps.info/spec.html) — no `source-map` npm package.
 * MCP-only utility: lives in src/core/, not src/modules/, so it never
 * registers as a scan module and never touches the paid scan+fix engine.
 */

const fs = require('fs');
const path = require('path');

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_LOOKUP = new Map();
for (let i = 0; i < BASE64_CHARS.length; i++) BASE64_LOOKUP.set(BASE64_CHARS[i], i);

// ---------------------------------------------------------------------------
// Base64 VLQ — decode advances posRef.i past the consumed characters;
// encode is the inverse, used to build test fixtures with confidence.
// ---------------------------------------------------------------------------

function decodeVLQSegment(str, posRef) {
  let result = 0;
  let multiplier = 1;
  let continuation;
  do {
    if (posRef.i >= str.length) throw new Error('Unexpected end of VLQ segment');
    const c = str[posRef.i++];
    const digit = BASE64_LOOKUP.get(c);
    if (digit === undefined) throw new Error(`Invalid base64 VLQ character: ${JSON.stringify(c)}`);
    continuation = (digit & 32) !== 0;
    result += (digit & 31) * multiplier;
    multiplier *= 32;
  } while (continuation);
  const negate = (result & 1) === 1;
  result = Math.floor(result / 2);
  return negate ? -result : result;
}

function encodeVLQSegment(value) {
  let vlq = value < 0 ? (-value * 2) + 1 : value * 2;
  let out = '';
  do {
    let digit = vlq & 31;
    vlq = Math.floor(vlq / 32);
    if (vlq > 0) digit |= 32;
    out += BASE64_CHARS[digit];
  } while (vlq > 0);
  return out;
}

// ---------------------------------------------------------------------------
// Mappings string -> per-generated-line array of segments. generatedColumn
// resets every line; sourceIndex/originalLine/originalColumn/nameIndex are
// cumulative across the whole mappings string, per the V3 spec.
// ---------------------------------------------------------------------------

function decodeMappings(mappingsStr) {
  const lines = String(mappingsStr || '').split(';');
  const result = [];
  let prevSourceIndex = 0;
  let prevOriginalLine = 0;
  let prevOriginalColumn = 0;
  let prevNameIndex = 0;

  for (const lineStr of lines) {
    const segments = [];
    let prevGeneratedColumn = 0;

    if (lineStr.length > 0) {
      for (const segStr of lineStr.split(',')) {
        if (!segStr) continue;
        const posRef = { i: 0 };

        prevGeneratedColumn += decodeVLQSegment(segStr, posRef);
        const segment = { generatedColumn: prevGeneratedColumn };

        if (posRef.i < segStr.length) {
          prevSourceIndex += decodeVLQSegment(segStr, posRef);
          segment.sourceIndex = prevSourceIndex;
          prevOriginalLine += decodeVLQSegment(segStr, posRef);
          segment.originalLine = prevOriginalLine;
          prevOriginalColumn += decodeVLQSegment(segStr, posRef);
          segment.originalColumn = prevOriginalColumn;

          if (posRef.i < segStr.length) {
            prevNameIndex += decodeVLQSegment(segStr, posRef);
            segment.nameIndex = prevNameIndex;
          }
        }
        segments.push(segment);
      }
    }
    result.push(segments);
  }
  return result;
}

/**
 * generatedLine/generatedColumn are 0-based. Segments within a line are
 * ascending by generatedColumn per spec — return the last segment at or
 * before the requested column.
 */
function findOriginalPosition(decodedLines, sources, names, generatedLine, generatedColumn) {
  if (generatedLine < 0 || generatedLine >= decodedLines.length) return null;
  const segments = decodedLines[generatedLine];
  if (!segments || segments.length === 0) return null;

  let best = null;
  for (const seg of segments) {
    if (seg.generatedColumn <= generatedColumn) best = seg;
    else break;
  }
  if (!best || best.sourceIndex === undefined) return null;

  return {
    source: sources[best.sourceIndex] != null ? sources[best.sourceIndex] : null,
    line: best.originalLine,
    column: best.originalColumn,
    name: best.nameIndex !== undefined && names[best.nameIndex] != null ? names[best.nameIndex] : null,
  };
}

// ---------------------------------------------------------------------------
// Locating the map for a generated JS file — inline data: URI or a sibling
// .map file referenced by a //# sourceMappingURL= comment.
// ---------------------------------------------------------------------------

function extractSourceMappingUrl(content) {
  const re = /\/\/[#@]\s*sourceMappingURL=(\S+)/g;
  let match;
  let last = null;
  while ((match = re.exec(content)) !== null) last = match[1];
  return last;
}

function loadSourceMapForFile(jsFilePath) {
  let content;
  try {
    content = fs.readFileSync(jsFilePath, 'utf8');
  } catch (err) {
    return { ok: false, reason: `cannot read ${jsFilePath}: ${err.message}` };
  }

  const url = extractSourceMappingUrl(content);
  if (!url) return { ok: false, reason: `no sourceMappingURL comment found in ${jsFilePath}` };

  let mapJsonText;
  let mapPath = null;

  if (url.startsWith('data:')) {
    const b64Match = url.match(/^data:application\/json(?:;charset=[^;]+)?;base64,(.+)$/);
    if (b64Match) {
      mapJsonText = Buffer.from(b64Match[1], 'base64').toString('utf8');
    } else {
      const plainMatch = url.match(/^data:application\/json(?:;charset=[^;]+)?,(.+)$/);
      if (!plainMatch) return { ok: false, reason: 'unsupported inline source map data URI encoding' };
      mapJsonText = decodeURIComponent(plainMatch[1]);
    }
  } else {
    mapPath = path.isAbsolute(url) ? url : path.join(path.dirname(jsFilePath), url);
    try {
      mapJsonText = fs.readFileSync(mapPath, 'utf8');
    } catch (err) {
      return { ok: false, reason: `cannot read source map ${mapPath}: ${err.message}` };
    }
  }

  let map;
  try {
    map = JSON.parse(mapJsonText);
  } catch (err) {
    return { ok: false, reason: `invalid JSON in source map: ${err.message}` };
  }
  if (!map || typeof map.mappings !== 'string' || !Array.isArray(map.sources)) {
    return { ok: false, reason: 'not a valid source map (missing mappings/sources)' };
  }

  return { ok: true, map, mapPath, jsFilePath };
}

// ---------------------------------------------------------------------------
// Single-frame resolution — file/line/column are 1-based (V8 convention).
// ---------------------------------------------------------------------------

function resolveStackFrame({ file, line, column }) {
  const generated = { file, line, column: typeof column === 'number' ? column : null };
  if (!file || typeof line !== 'number' || line < 1) {
    return { ok: false, reason: 'file and a 1-based line number are required', generated };
  }

  const loaded = loadSourceMapForFile(file);
  if (!loaded.ok) return { ok: false, reason: loaded.reason, generated };

  const decoded = decodeMappings(loaded.map.mappings);
  const generatedLine0 = line - 1;
  const generatedColumn0 = typeof column === 'number' && column > 0 ? column - 1 : 0;
  const pos = findOriginalPosition(decoded, loaded.map.sources, loaded.map.names || [], generatedLine0, generatedColumn0);
  if (!pos) return { ok: false, reason: `no source-map entry for ${file}:${line}:${column}`, generated };

  const sourceRoot = loaded.map.sourceRoot || '';
  const resolvedSource = pos.source != null ? (sourceRoot ? path.posix.join(sourceRoot, pos.source) : pos.source) : null;

  let snippet = null;
  if (Array.isArray(loaded.map.sourcesContent)) {
    const idx = loaded.map.sources.indexOf(pos.source);
    const content = idx >= 0 ? loaded.map.sourcesContent[idx] : null;
    if (typeof content === 'string') {
      const contentLines = content.split('\n');
      snippet = contentLines[pos.line] != null ? contentLines[pos.line] : null;
    }
  }

  return {
    ok: true,
    generated,
    original: {
      source: resolvedSource,
      line: pos.line + 1,
      column: pos.column + 1,
      name: pos.name,
      snippet,
    },
  };
}

// ---------------------------------------------------------------------------
// Stack-trace text parsing — V8 ("at fn (file:line:col)") and
// Firefox/Safari ("fn@file:line:col") single-line frame formats. Frames
// that don't match either shape (eval wrappers, exotic formats) are
// skipped rather than mis-parsed.
// ---------------------------------------------------------------------------

const V8_FRAME_RE = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;
const FIREFOX_FRAME_RE = /^([^@\s]*)@(.+?):(\d+):(\d+)\s*$/;

function parseStackTrace(text) {
  if (typeof text !== 'string') return [];
  const frames = [];
  for (const rawLine of text.split('\n')) {
    const v8 = rawLine.match(V8_FRAME_RE);
    if (v8) {
      frames.push({
        raw: rawLine.trim(),
        functionName: v8[1] || null,
        file: v8[2],
        line: parseInt(v8[3], 10),
        column: parseInt(v8[4], 10),
      });
      continue;
    }
    const ff = rawLine.match(FIREFOX_FRAME_RE);
    if (ff) {
      frames.push({
        raw: rawLine.trim(),
        functionName: ff[1] || null,
        file: ff[2],
        line: parseInt(ff[3], 10),
        column: parseInt(ff[4], 10),
      });
    }
  }
  return frames;
}

function resolveStackTrace(text) {
  const frames = parseStackTrace(text);
  return frames.map((f) => {
    let file = f.file;
    if (file.startsWith('file://')) {
      try { file = new URL(file).pathname; } catch { /* keep as-is */ }
    }
    const resolution = resolveStackFrame({ file, line: f.line, column: f.column });
    return { ...f, file, resolution };
  });
}

module.exports = {
  encodeVLQSegment,
  decodeVLQSegment,
  decodeMappings,
  findOriginalPosition,
  extractSourceMappingUrl,
  loadSourceMapForFile,
  resolveStackFrame,
  parseStackTrace,
  resolveStackTrace,
};
