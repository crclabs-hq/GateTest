#!/usr/bin/env node
'use strict';

// =============================================================================
// BUILD THE WORDPRESS PLUGIN ZIP — wp-plugin/ → dist/gatetest-health-check.zip
// =============================================================================
// WordPress installs a plugin from a zip whose top level is the plugin folder
// (`gatetest-health-check/gatetest-health-check.php`, …); a zip of the bare
// files installs into wp-content/plugins/ with a random name and no slug.
// This writes that layout with nothing but node's zlib — no `zip` binary
// (absent on Windows runners and dev boxes) and no npm dependency — so the
// same file is produced locally, in ci, and by publish.yml's release job.
//
// Excluded: dotfiles (.gitkeep, .DS_Store, .git*), source maps, and the dev
// files a plugin directory never ships (tests/, composer/npm manifests).
//
//   node scripts/build-wp-plugin-zip.js            → dist/gatetest-health-check.zip
//   node scripts/build-wp-plugin-zip.js --out X    → X
//
// Timestamps come from SOURCE_DATE_EPOCH when set so a release build is
// byte-for-byte reproducible; otherwise the build time is used.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const REPO_ROOT = path.resolve(__dirname, '..');
const PLUGIN_SLUG = 'gatetest-health-check';
const PLUGIN_DIR = path.join(REPO_ROOT, 'wp-plugin');
const DEFAULT_OUT = path.join(REPO_ROOT, 'dist', `${PLUGIN_SLUG}.zip`);

const EXCLUDED_DIRS = new Set(['node_modules', 'tests', 'test', 'vendor']);
const EXCLUDED_FILES = new Set(['composer.json', 'composer.lock', 'package.json', 'package-lock.json', 'phpcs.xml', 'phpunit.xml']);

/** Every shippable file under `dir`, as forward-slash paths relative to it, sorted. */
function collectPluginFiles(dir) {
  const out = [];
  (function walk(current, rel) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) walk(path.join(current, entry.name), relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (EXCLUDED_FILES.has(entry.name) || entry.name.endsWith('.map')) continue;
      out.push(relPath);
    }
  })(dir, '');
  return out;
}

// --- minimal zip writer (PKWARE APPNOTE 4.4.x: local headers, central dir, EOCD)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time pair (what zip headers store), from a Date. */
function dosDateTime(d) {
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const date = ((Math.max(1980, d.getUTCFullYear()) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

/**
 * Write a zip of `files` ({ name, data }) to `outFile`. Deflate when it
 * helps, store otherwise. Returns the entry names in archive order.
 */
function writeZip(outFile, files, when) {
  const { time, date } = dosDateTime(when);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);      // made by: UNIX, spec 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);          // extra
    central.writeUInt16LE(0, 32);          // comment
    central.writeUInt16LE(0, 34);          // disk
    central.writeUInt16LE(0, 36);          // internal attrs
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external: -rw-r--r--
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }

  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, Buffer.concat([...locals, ...centrals, eocd]));
  return files.map((f) => f.name);
}

/** The entry names in a zip, read from its central directory. */
function listZipEntries(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`${file}: no end-of-central-directory record`);
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error(`${file}: bad central directory entry at ${pos}`);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    names.push({
      name: buf.toString('utf8', pos + 46, pos + 46 + nameLen),
      size: buf.readUInt32LE(pos + 24),
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/**
 * Build the plugin zip. Returns { outFile, entries } — every entry is
 * `<slug>/<path>` so the archive unpacks to one plugin folder.
 */
function buildPluginZip({ pluginDir = PLUGIN_DIR, outFile = DEFAULT_OUT, slug = PLUGIN_SLUG } = {}) {
  const rel = collectPluginFiles(pluginDir);
  if (!rel.includes(`${slug}.php`)) {
    throw new Error(`${pluginDir} has no ${slug}.php — the main plugin file must be named after the slug`);
  }
  const epoch = process.env.SOURCE_DATE_EPOCH ? Number(process.env.SOURCE_DATE_EPOCH) * 1000 : Date.now();
  const files = rel.map((p) => ({ name: `${slug}/${p}`, data: fs.readFileSync(path.join(pluginDir, p)) }));
  const entries = writeZip(outFile, files, new Date(epoch));
  return { outFile, entries };
}

module.exports = { buildPluginZip, collectPluginFiles, listZipEntries, PLUGIN_DIR, PLUGIN_SLUG };

if (require.main === module) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outFile = outIdx >= 0 && args[outIdx + 1] ? path.resolve(args[outIdx + 1]) : DEFAULT_OUT;
  const { entries } = buildPluginZip({ outFile });
  const bytes = fs.statSync(outFile).size;
  console.log(`${path.relative(process.cwd(), outFile)} — ${entries.length} files, ${bytes} bytes`);
  for (const e of listZipEntries(outFile)) console.log(`  ${String(e.size).padStart(7)}  ${e.name}`);
}
