'use strict';

// REPO SNAPSHOT TEST — the credential-free public-repo reader that keeps the
// free-scan funnel alive when every git-host token is dead (KI #100/#101).
//
// Behavioural tests with an injected fetch: the tar parser is exercised on
// archives built in-process (no network), and the three call sites that used
// to refuse to proceed without a token are checked by source-text contract
// so nobody quietly reintroduces the "no token → 403" dead end.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const {
  fetchPublicRepoSnapshot,
  parseTar,
  tarballUrl,
  fetchPublicGitlabSnapshot,
  gitlabTarballUrl,
  isValidGitlabProjectPath,
} = require('../website/app/lib/repo-snapshot.js');

// ── minimal tar writer (ustar) for fixtures ────────────────────────────────
function tarEntry(name, data, type = '0') {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8);
  header.write('0000000\0', 108, 8);
  header.write('0000000\0', 116, 8);
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12);
  header.write('00000000000\0', 136, 12);
  header.write('        ', 148, 8); // checksum placeholder
  header.write(type, 156, 1);
  header.write('ustar\0', 257, 6);
  header.write('00', 263, 2);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512, 0);
  data.copy(padded);
  return Buffer.concat([header, padded]);
}
function buildTar(entries) {
  const parts = entries.map(([name, body, type]) =>
    tarEntry(name, Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'), type));
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}
function fakeFetch(status, gzBuffer, headers = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    body: null,
    arrayBuffer: async () => gzBuffer.buffer.slice(gzBuffer.byteOffset, gzBuffer.byteOffset + gzBuffer.byteLength),
  });
}

describe('repo-snapshot — tar parsing', () => {
  it('reads regular files, strips the archive top-level dir, skips dirs and binaries', () => {
    const tar = buildTar([
      ['repo-abc123/', '', '5'],
      ['repo-abc123/package.json', '{"name":"x"}'],
      ['repo-abc123/src/index.js', 'module.exports = 1;\n'],
      ['repo-abc123/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])],
    ]);
    const { entries, allPaths, truncated } = parseTar(tar, { maxFileBytes: 1e6, maxFiles: 100 });
    assert.deepStrictEqual(allPaths, ['package.json', 'src/index.js', 'logo.png']);
    assert.strictEqual(entries.get('package.json').toString(), '{"name":"x"}');
    assert.strictEqual(entries.get('src/index.js').toString(), 'module.exports = 1;\n');
    assert.strictEqual(entries.has('logo.png'), false, 'binary content is not kept');
    assert.strictEqual(truncated, false);
  });

  it('honours the ustar prefix field for long paths', () => {
    const tar = buildTar([['repo-1/a.js', 'x']]);
    // Rewrite entry 0 to put a directory in the prefix field (offset 345).
    tar.write('repo-1/deep/nested', 345, 155, 'utf8');
    tar.write('a.js\0', 0, 100, 'utf8');
    const { allPaths } = parseTar(tar, { maxFileBytes: 1e6, maxFiles: 100 });
    assert.deepStrictEqual(allPaths, ['deep/nested/a.js']);
  });

  it('caps the number of kept files and reports truncation', () => {
    const tar = buildTar([
      ['r/a.js', '1'], ['r/b.js', '2'], ['r/c.js', '3'],
    ]);
    const { entries, allPaths, truncated } = parseTar(tar, { maxFileBytes: 1e6, maxFiles: 2 });
    assert.strictEqual(entries.size, 2);
    assert.strictEqual(allPaths.length, 3, 'paths are still enumerated past the cap');
    assert.strictEqual(truncated, true);
  });

  it('skips single files over maxFileBytes but still lists their path', () => {
    const tar = buildTar([['r/big.js', 'x'.repeat(2000)], ['r/small.js', 'y']]);
    const { entries, allPaths } = parseTar(tar, { maxFileBytes: 1000, maxFiles: 100 });
    assert.deepStrictEqual(allPaths, ['big.js', 'small.js']);
    assert.strictEqual(entries.has('big.js'), false);
    assert.strictEqual(entries.has('small.js'), true);
  });
});

describe('repo-snapshot — fetchPublicRepoSnapshot', () => {
  it('builds the anonymous codeload URL (no api.github.com, no token)', () => {
    assert.strictEqual(tarballUrl('o', 'r', 'HEAD'), 'https://codeload.github.com/o/r/tar.gz/HEAD');
    assert.strictEqual(tarballUrl('o', 'r'), 'https://codeload.github.com/o/r/tar.gz/HEAD');
  });

  it('returns paths + decoded contents from a gzipped tarball', async () => {
    const gz = zlib.gzipSync(buildTar([['r-1/README.md', '# hi'], ['r-1/lib/x.py', 'print(1)']]));
    const snap = await fetchPublicRepoSnapshot('o', 'r', 'HEAD', { fetchImpl: fakeFetch(200, gz) });
    assert.deepStrictEqual(snap.paths, ['README.md', 'lib/x.py']);
    assert.strictEqual(snap.contents.get('lib/x.py'), 'print(1)');
    assert.strictEqual(snap.source, 'tarball');
    assert.strictEqual(snap.truncated, false);
    assert.strictEqual(snap.warning, null);
  });

  it('turns a 404 into a caller-facing "private or missing" error', async () => {
    await assert.rejects(
      fetchPublicRepoSnapshot('o', 'r', 'HEAD', { fetchImpl: fakeFetch(404, Buffer.alloc(0)) }),
      /not found \(404\).*private, does not exist/
    );
  });

  it('refuses archives over the byte cap before downloading them', async () => {
    const gz = zlib.gzipSync(buildTar([['r/a', 'x']]));
    await assert.rejects(
      fetchPublicRepoSnapshot('o', 'r', 'HEAD', {
        fetchImpl: fakeFetch(200, gz, { 'content-length': String(10 * 1024 * 1024) }),
        maxBytes: 1024,
      }),
      /over the 1024-byte snapshot cap/
    );
  });

  it('rejects owner/repo names that could smuggle path segments', async () => {
    await assert.rejects(fetchPublicRepoSnapshot('../evil', 'r'), /invalid repository name/);
    await assert.rejects(fetchPublicRepoSnapshot('o', 'r/../../x'), /invalid repository name/);
  });

  it('reports a warning when the file cap truncates the snapshot', async () => {
    const gz = zlib.gzipSync(buildTar([['r/a.js', '1'], ['r/b.js', '2']]));
    const snap = await fetchPublicRepoSnapshot('o', 'r', 'HEAD', { fetchImpl: fakeFetch(200, gz), maxFiles: 1 });
    assert.strictEqual(snap.truncated, true);
    assert.match(snap.warning, /more than 1 text files/);
  });
});

// ── gitlab.com support (board item, PR #599 follow-up) ──────────────────────
// Same tar/gzip machinery as GitHub above (GitLab's archive wraps entries in
// the same "{project}-{sha}/" shape), so the control pair here is: a public
// project (incl. a subgroup path) is fetched and parsed exactly like GitHub;
// 401/403/404 throw WITH `.httpStatus` set so the caller can tell "the host
// said no" apart from a network failure and report `gitlab:not-accessible`
// instead of retrying forever.
describe('repo-snapshot — fetchPublicGitlabSnapshot', () => {
  it('builds the v4 archive URL with the full (possibly-subgrouped) project path URL-encoded', () => {
    assert.strictEqual(
      gitlabTarballUrl('group/subgroup/project', 'main'),
      'https://gitlab.com/api/v4/projects/group%2Fsubgroup%2Fproject/repository/archive.tar.gz?sha=main'
    );
    assert.strictEqual(
      gitlabTarballUrl('bob/service', 'v1.0'),
      'https://gitlab.com/api/v4/projects/bob%2Fservice/repository/archive.tar.gz?sha=v1.0'
    );
  });

  it('validates project paths (segment-shaped, at least namespace/project, no path-traversal smuggling)', () => {
    assert.strictEqual(isValidGitlabProjectPath('bob/service'), true);
    assert.strictEqual(isValidGitlabProjectPath('group/subgroup/project'), true);
    assert.strictEqual(isValidGitlabProjectPath('onlyone'), false);
    assert.strictEqual(isValidGitlabProjectPath('../evil/x'), false);
    assert.strictEqual(isValidGitlabProjectPath('a/../../etc'), false);
    assert.strictEqual(isValidGitlabProjectPath(''), false);
  });

  it('fetches a public project (positive control) — subgroup path, paths + decoded contents', async () => {
    const gz = zlib.gzipSync(buildTar([
      ['group-subgroup-project-abc123/README.md', '# hi'],
      ['group-subgroup-project-abc123/lib/x.py', 'print(1)'],
    ]));
    const snap = await fetchPublicGitlabSnapshot('group/subgroup/project', 'main', { fetchImpl: fakeFetch(200, gz) });
    assert.deepStrictEqual(snap.paths, ['README.md', 'lib/x.py']);
    assert.strictEqual(snap.contents.get('lib/x.py'), 'print(1)');
    assert.strictEqual(snap.source, 'gitlab-tarball');
    assert.strictEqual(snap.truncated, false);
  });

  it('turns a 404 into an httpStatus-tagged "private or missing" error — never accepted for retry', async () => {
    await assert.rejects(
      fetchPublicGitlabSnapshot('bob/service', 'main', { fetchImpl: fakeFetch(404, Buffer.alloc(0)) }),
      (err) => {
        assert.match(err.message, /not found \(404\).*private, does not exist/);
        assert.strictEqual(err.httpStatus, 404);
        return true;
      }
    );
  });

  it('tags 401/403 with httpStatus too (private project, access-restricted)', async () => {
    await assert.rejects(
      fetchPublicGitlabSnapshot('bob/service', 'main', { fetchImpl: fakeFetch(401, Buffer.alloc(0)) }),
      (err) => { assert.strictEqual(err.httpStatus, 401); return true; }
    );
    await assert.rejects(
      fetchPublicGitlabSnapshot('bob/service', 'main', { fetchImpl: fakeFetch(403, Buffer.alloc(0)) }),
      (err) => { assert.strictEqual(err.httpStatus, 403); return true; }
    );
  });

  it('does not tag a network/decompression/other failure with httpStatus (a 500 retries like any host)', async () => {
    await assert.rejects(
      fetchPublicGitlabSnapshot('bob/service', 'main', { fetchImpl: fakeFetch(500, Buffer.alloc(0)) }),
      (err) => { assert.strictEqual(err.httpStatus, 500); return true; }
    );
    // A genuinely invalid path never reaches the network at all.
    await assert.rejects(fetchPublicGitlabSnapshot('onlyone', 'main'), /invalid gitlab project path/);
  });

  it('refuses archives over the byte cap before downloading them, same as GitHub', async () => {
    const gz = zlib.gzipSync(buildTar([['r/a', 'x']]));
    await assert.rejects(
      fetchPublicGitlabSnapshot('bob/service', 'main', {
        fetchImpl: fakeFetch(200, gz, { 'content-length': String(10 * 1024 * 1024) }),
        maxBytes: 1024,
      }),
      /over the 1024-byte snapshot cap/
    );
  });
});

describe('repo-snapshot — wiring contract (KI #100/#101 must not regress)', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', 'website', 'app', rel), 'utf8');

  it('gluecron-client falls back to the public snapshot for BOTH tree and blob reads', () => {
    const src = read('lib/gluecron-client.ts');
    assert.match(src, /require\(["']\.\/repo-snapshot["']\)/);
    // tree: snapshot tried after github + gluecron, before throwing
    assert.match(src, /const snap = await publicSnapshot\(owner, repo, ref\);[\s\S]*?return \{ paths: snap\.paths/);
    // blob: snapshot lookup is the terminal fallback, not `return ""`
    assert.match(src, /return snap\.contents\.get\(filePath\) \|\| ""/);
    // a failed download is memoised only briefly (2026-09-25: the blob rung
    // after it would otherwise re-download an over-cap archive once per blob),
    // and for strictly less time than a successful one
    assert.match(src, /promise\.catch\(\(\) => snapshotMemo\.set\(key, \{ expires: Date\.now\(\) \+ SNAPSHOT_FAIL_TTL_MS, promise \}\)\)/);
    const ttl = Number((src.match(/const SNAPSHOT_TTL_MS = ([\d_]+);/) || [])[1].replace(/_/g, ''));
    const failTtl = Number((src.match(/const SNAPSHOT_FAIL_TTL_MS = ([\d_]+);/) || [])[1].replace(/_/g, ''));
    assert.ok(failTtl > 0 && failTtl < ttl, `SNAPSHOT_FAIL_TTL_MS (${failTtl}) must be positive and shorter than SNAPSHOT_TTL_MS (${ttl})`);
  });

  it('the free preview, playground stream and paid run no longer refuse a public repo when no token exists', () => {
    for (const rel of ['api/scan/preview/route.ts', 'api/playground/scan/stream/route.ts', 'api/scan/run/route.ts']) {
      const src = read(rel);
      assert.doesNotMatch(src, /if \(!token\) \{[\s\S]{0,300}(status: 403|Cannot access)/,
        `${rel} still dead-ends on a missing token`);
      assert.match(src, /const token = auth\.token \|\| ""/, `${rel} should proceed with an empty token`);
    }
  });
});

// ── gitlab.com fetch-layer wiring (board item, PR #599 follow-up) ──────────
// scan-worker.js's isGitRepoUrl has recognised gitlab.com since #599; these
// pin that scan-executor.ts and gluecron-client.ts actually fetch it now
// instead of falling through to a retry storm. Both files are TypeScript —
// same source-text-contract approach as tests/github-hardening.test.js,
// which documents why (no transpile step in `node --test`).
describe('gitlab.com fetch-layer wiring', () => {
  const readWebsite = (rel) => fs.readFileSync(path.join(__dirname, '..', 'website', 'app', rel), 'utf8');

  it('gluecron-client exports loadGitlabRepoFiles, unauthenticated, resolving the default branch before archiving', () => {
    const src = readWebsite('lib/gluecron-client.ts');
    assert.match(src, /export\s+async\s+function\s+loadGitlabRepoFiles/);
    assert.match(src, /resolveGitlabDefaultBranch/);
    // No token/credential anywhere in the gitlab path — public repos only.
    const gitlabSection = src.slice(src.indexOf('gitlab.com support'));
    assert.doesNotMatch(gitlabSection, /GITLAB_API_TOKEN|GITLAB_TOKEN/, 'gitlab.com support must stay unauthenticated (public repos only)');
    assert.match(gitlabSection, /fetchWithTimeout\(/, 'the default-branch lookup must use the bounded fetch wrapper, never bare fetch');
  });

  it('scan-executor detects gitlab.com by hostname segment (never substring) BEFORE the owner/repo-only regexes', () => {
    const src = readWebsite('lib/scan-executor.ts');
    assert.match(src, /const GITLAB_URL_RE = \/\^https\?:/, 'declares an anchored gitlab.com host regex');
    assert.match(src, /gitlab\\\.com\\\//, 'the regex requires the literal host segment "gitlab.com/"');
    // `runScan(` with the literal paren excludes runScanDirect(/runScanJob(,
    // which both also start with the substring "runScan".
    const runScanBody = src.slice(src.indexOf('export async function runScan('));
    // gitlab is matched before the gluecron/github owner/repo regexes, which
    // only ever capture two path segments and would truncate a subgroup path.
    assert.ok(
      runScanBody.indexOf('GITLAB_URL_RE') < runScanBody.indexOf('gluecronMatch'),
      'gitlab.com must be checked before the two-segment owner/repo regexes'
    );
  });

  it('a gitlab.com project scan-executor cannot access reports notChecked, never a plain failure', () => {
    const src = readWebsite('lib/scan-executor.ts');
    assert.match(src, /notChecked\s*=\s*true/);
    assert.match(src, /notCheckedReason\s*=\s*"gitlab:not-accessible"/);
    // Only for the http-status-tagged failures — not every archive-read error.
    assert.match(src, /httpStatus\s*===\s*401\s*\|\|\s*httpStatus\s*===\s*403\s*\|\|\s*httpStatus\s*===\s*404/);
  });

  it('scan-worker routes a notChecked git-URL scan to markNotChecked, never markFailed/retry', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'website', 'app', 'lib', 'scan-worker.js'), 'utf8');
    assert.match(src, /scanResult\.notChecked/);
    assert.match(src, /queueStore\.markNotChecked\(job\.id, reason, sql\)/);
  });
});
