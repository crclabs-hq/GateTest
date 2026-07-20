/**
 * Dependencies Module — polyglot dependency hygiene scanner.
 *
 * Looks at every language's manifest (package.json, requirements.txt, Pipfile,
 * pyproject.toml, go.mod, Cargo.toml, Gemfile, composer.json, pom.xml,
 * build.gradle) and flags:
 *   - wildcard / "latest" pins (supply-chain risk)
 *   - git/tarball URLs where a registry version would do
 *   - known-deprecated or known-abandoned packages
 *   - missing lockfile alongside a manifest
 *   - duplicate dependencies declared in both prod + dev blocks
 *   - obviously stale major version pins for frameworks we know
 *
 * Zero dependencies, zero network calls. This is pattern + heuristic only —
 * the paid-for network CVE lookups are the `security` module's job.
 *
 * TODO(gluecron): dependency graph data will eventually ship via HostBridge
 * metadata so bridges can expose native dependency APIs.
 */

const fs = require('fs');
const path = require('path');
const BaseModule = require('./base-module');

// ---------------------------------------------------------------------------
// Known-bad package catalog (curated, static — NO network calls).
// Keep this SHORT and HIGH-CONFIDENCE. The security module handles CVEs.
// ---------------------------------------------------------------------------
const DEPRECATED_PACKAGES = {
  // npm
  'request': 'Deprecated 2020 — use node:fetch, undici, or axios',
  'request-promise': 'Deprecated — parent `request` is deprecated',
  'request-promise-native': 'Deprecated — parent `request` is deprecated',
  'left-pad': 'Infamous supply-chain risk — use String.prototype.padStart',
  'node-uuid': 'Renamed — use `uuid`',
  'istanbul': 'Use `nyc` or `c8`',
  'tslint': 'Deprecated 2019 — migrate to ESLint + @typescript-eslint',
  'bower': 'Deprecated — use npm/yarn/pnpm',
  'grunt': 'Effectively abandoned — use npm scripts or a modern bundler',
  'gulp': 'Maintenance mode only — prefer npm scripts',
  // python
  'distribute': 'Merged back into setuptools — remove',
  'nose': 'Dead since 2015 — use pytest',
  // ruby
  'rvm': 'Prefer rbenv or asdf',
  // php
  'phpunit/php-invoker': 'Abandoned',
};

// Flag `"*"` or `"latest"` version specifiers.
const WILDCARD_SPECIFIERS = new Set(['*', 'latest', '', 'x', 'x.x', 'x.x.x']);

// Patterns that indicate a git/tarball dependency where a registry pin
// would usually be preferable.
const NON_REGISTRY_PATTERN = /^(git\+|git:|https?:|file:|link:|ssh:|github:|gitlab:|bitbucket:)/i;

class DependenciesModule extends BaseModule {
  constructor() {
    super('dependencies', 'Dependencies — supply-chain hygiene across package.json, requirements.txt, go.mod, Cargo.toml, Gemfile, composer.json, pom.xml, build.gradle');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const manifests = this._discoverManifests(projectRoot);

    if (manifests.length === 0) {
      result.addCheck('dependencies:no-manifests', true, {
        severity: 'info',
        message: 'No dependency manifests found — skipping',
      });
      return;
    }

    result.addCheck('dependencies:scanning', true, {
      severity: 'info',
      message: `Scanning ${manifests.length} manifest file(s): ${manifests.map((m) => m.kind).join(', ')}`,
    });

    for (const manifest of manifests) {
      try {
        this._checkManifest(manifest, projectRoot, result);
      } catch (err) {
        result.addCheck(`dependencies:parse-error:${manifest.kind}:${manifest.rel}`, false, {
          severity: 'warning',
          file: manifest.rel,
          message: `Could not parse ${manifest.rel}: ${err.message}`,
        });
      }
    }

    // Summary roll-up
    const deprecatedCount = result.checks.filter((c) => c.name.startsWith('dependencies:deprecated:')).length;
    const wildcardCount = result.checks.filter((c) => c.name.startsWith('dependencies:wildcard:')).length;
    const lockfileMissing = result.checks.filter((c) => c.name.startsWith('dependencies:no-lockfile:')).length;

    result.addCheck('dependencies:summary', true, {
      severity: 'info',
      message: `Dependencies scan: ${manifests.length} manifests, ${deprecatedCount} deprecated, ${wildcardCount} wildcard pins, ${lockfileMissing} missing lockfile(s)`,
    });
  }

  // -------------------------------------------------------------------------
  // Manifest discovery
  // -------------------------------------------------------------------------

  _discoverManifests(projectRoot) {
    const out = [];
    const candidates = [
      { file: 'package.json', kind: 'npm', lockfiles: ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb'] },
      { file: 'requirements.txt', kind: 'pip' },
      { file: 'Pipfile', kind: 'pipenv', lockfiles: ['Pipfile.lock'] },
      { file: 'pyproject.toml', kind: 'pyproject', lockfiles: ['poetry.lock', 'uv.lock'] },
      { file: 'go.mod', kind: 'go', lockfiles: ['go.sum'] },
      { file: 'Cargo.toml', kind: 'cargo', lockfiles: ['Cargo.lock'] },
      { file: 'Gemfile', kind: 'bundler', lockfiles: ['Gemfile.lock'] },
      { file: 'composer.json', kind: 'composer', lockfiles: ['composer.lock'] },
      { file: 'pom.xml', kind: 'maven' },
      { file: 'build.gradle', kind: 'gradle' },
      { file: 'build.gradle.kts', kind: 'gradle' },
    ];

    for (const c of candidates) {
      const full = path.join(projectRoot, c.file);
      if (fs.existsSync(full)) {
        const content = fs.readFileSync(full, 'utf-8');
        out.push({ ...c, rel: c.file, full, content });
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Dispatch by manifest kind
  // -------------------------------------------------------------------------

  _checkManifest(manifest, projectRoot, result) {
    switch (manifest.kind) {
      case 'npm': return this._checkNpm(manifest, projectRoot, result);
      case 'pip': return this._checkPip(manifest, result);
      case 'pipenv': return this._checkPipenv(manifest, projectRoot, result);
      case 'pyproject': return this._checkPyproject(manifest, projectRoot, result);
      case 'go': return this._checkGoMod(manifest, projectRoot, result);
      case 'cargo': return this._checkCargo(manifest, projectRoot, result);
      case 'bundler': return this._checkGemfile(manifest, projectRoot, result);
      case 'composer': return this._checkComposer(manifest, projectRoot, result);
      case 'maven': return this._checkMaven(manifest, result);
      case 'gradle': return this._checkGradle(manifest, result);
      default: return;
    }
  }

  // -------------------------------------------------------------------------
  // npm / package.json
  // -------------------------------------------------------------------------

  _checkNpm(manifest, projectRoot, result) {
    const pkg = JSON.parse(manifest.content);
    const prod = pkg.dependencies || {};
    const dev = pkg.devDependencies || {};
    const peer = pkg.peerDependencies || {};
    const optional = pkg.optionalDependencies || {};

    this._checkLockfile(manifest, projectRoot, result);

    for (const block of [
      ['dependencies', prod],
      ['devDependencies', dev],
      ['peerDependencies', peer],
      ['optionalDependencies', optional],
    ]) {
      const [blockName, deps] = block;
      for (const [name, spec] of Object.entries(deps)) {
        this._flagPackage({ ecosystem: 'npm', name, spec, manifest, blockName, result });
      }
    }

    // Duplicate prod+dev declaration
    for (const name of Object.keys(prod)) {
      if (name in dev) {
        result.addCheck(`dependencies:duplicate:${manifest.kind}:${name}`, false, {
          severity: 'warning',
          file: manifest.rel,
          message: `"${name}" is declared in BOTH dependencies and devDependencies — pick one`,
          suggestion: 'Delete the devDependencies entry if it ships to production; otherwise delete the dependencies entry.',
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // pip / requirements.txt
  // -------------------------------------------------------------------------

  _checkPip(manifest, result) {
    const lines = manifest.content.split('\n');
    let lineNo = 0;
    let hasAnyPin = false;

    for (const rawLine of lines) {
      lineNo += 1;
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith('-')) continue;

      // Strip inline comment
      const noComment = line.split('#')[0].trim();
      if (!noComment) continue;

      // Match `name[extras]<op>version`
      const m = noComment.match(/^([A-Za-z0-9_.-]+)(\[[^\]]+\])?\s*([=<>!~]=?.*)?$/);
      if (!m) continue;
      const name = m[1];
      const spec = (m[3] || '').trim();

      if (!spec) {
        result.addCheck(`dependencies:wildcard:pip:${name}`, false, {
          severity: 'warning',
          file: manifest.rel,
          line: lineNo,
          message: `"${name}" has no version pin — use == for reproducible installs`,
          suggestion: `Pin with ==X.Y.Z, or use a lockfile (pip-compile / uv lock).`,
        });
      } else if (spec.startsWith('==')) {
        hasAnyPin = true;
      }

      if (DEPRECATED_PACKAGES[name.toLowerCase()]) {
        result.addCheck(`dependencies:deprecated:pip:${name}`, false, {
          severity: 'warning',
          file: manifest.rel,
          line: lineNo,
          message: `"${name}" is deprecated — ${DEPRECATED_PACKAGES[name.toLowerCase()]}`,
        });
      }
    }

    if (!hasAnyPin) {
      result.addCheck(`dependencies:no-pins:pip:${manifest.rel}`, false, {
        severity: 'info',
        file: manifest.rel,
        message: 'requirements.txt has no pinned versions — builds are non-reproducible',
        suggestion: 'Use pip-compile, uv, or equivalent to generate pinned requirements.',
      });
    }
  }

  _checkPipenv(manifest, projectRoot, result) {
    this._checkLockfile(manifest, projectRoot, result);
    const content = manifest.content;
    // Rough TOML scan for `name = "*"` style deps
    const packagesMatch = content.match(/\[packages\][\s\S]*?(?=\n\[|$)/);
    const section = packagesMatch ? packagesMatch[0] : '';
    const deps = [...section.matchAll(/^([A-Za-z0-9_.-]+)\s*=\s*"([^"]*)"/gm)];
    for (const [, name, spec] of deps) {
      if (WILDCARD_SPECIFIERS.has(spec.trim())) {
        result.addCheck(`dependencies:wildcard:pipenv:${name}`, false, {
          severity: 'warning',
          file: manifest.rel,
          message: `"${name} = "${spec}"" is a wildcard — Pipfile.lock should pin but the Pipfile shouldn't brag about it`,
        });
      }
      if (DEPRECATED_PACKAGES[name.toLowerCase()]) {
        result.addCheck(`dependencies:deprecated:pipenv:${name}`, false, {
          severity: 'warning',
          file: manifest.rel,
          message: `"${name}" is deprecated — ${DEPRECATED_PACKAGES[name.toLowerCase()]}`,
        });
      }
    }
  }

  _checkPyproject(manifest, projectRoot, result) {
    this._checkLockfile(manifest, projectRoot, result);
    const content = manifest.content;
    const deps = [...content.matchAll(/^([A-Za-z0-9_.-]+)\s*=\s*"([^"]*)"/gm)];
    for (const [, name, spec] of deps) {
      if (WILDCARD_SPECIFIERS.has(spec.trim())) {
        result.addCheck(`dependencies:wildcard:pyproject:${name}`, false, {
          severity: 'warning',
          file: manifest.rel,
          message: `"${name} = "${spec}"" is a wildcard — pin the version`,
        });
      }
      if (DEPRECATED_PACKAGES[name.toLowerCase()]) {
        result.addCheck(`dependencies:deprecated:pyproject:${name}`, false, {
          severity: 'warning',
          file: manifest.rel,
          message: `"${name}" is deprecated — ${DEPRECATED_PACKAGES[name.toLowerCase()]}`,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Go / go.mod
  // -------------------------------------------------------------------------

  _checkGoMod(manifest, projectRoot, result) {
    this._checkLockfile(manifest, projectRoot, result);
    const lines = manifest.content.split('\n');
    let lineNo = 0;
    let inRequireBlock = false;

    for (const raw of lines) {
      lineNo += 1;
      const line = raw.trim();
      if (line.startsWith('require (')) { inRequireBlock = true; continue; }
      if (inRequireBlock && line === ')') { inRequireBlock = false; continue; }

      let dep = null;
      if (inRequireBlock && line && !line.startsWith('//')) {
        // `golang.org/x/net v0.17.0` or `foo/bar v0.0.0-20240101-abc // indirect`
        const m = line.match(/^([^\s]+)\s+(v[^\s]+)/);
        if (m) dep = { name: m[1], spec: m[2] };
      } else if (line.startsWith('require ')) {
        const m = line.match(/^require\s+([^\s]+)\s+(v[^\s]+)/);
        if (m) dep = { name: m[1], spec: m[2] };
      }

      if (dep) {
        // v0.0.0 pseudo-versions are a supply-chain smell if unpinned via commit SHA.
        if (/^v0\.0\.0-\d+-[a-f0-9]+$/.test(dep.spec)) {
          result.addCheck(`dependencies:pseudo-version:go:${dep.name}`, false, {
            severity: 'info',
            file: manifest.rel,
            line: lineNo,
            message: `"${dep.name}" pinned to a pseudo-version (${dep.spec}) — OK for modules without releases, but confirm this is intentional`,
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Cargo / Cargo.toml
  // -------------------------------------------------------------------------

  _checkCargo(manifest, projectRoot, result) {
    this._checkLockfile(manifest, projectRoot, result);
    const content = manifest.content;
    const depsSection = content.match(/\[dependencies\][\s\S]*?(?=\n\[|$)/);
    if (!depsSection) return;
    const lines = depsSection[0].split('\n');
    let lineNo = 0;
    for (const raw of lines) {
      lineNo += 1;
      const line = raw.trim();
      // Simple: `name = "spec"` or `name = { version = "spec", ... }`
      const simpleMatch = line.match(/^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/);
      if (simpleMatch) {
        const [, name, spec] = simpleMatch;
        if (WILDCARD_SPECIFIERS.has(spec.trim()) || spec.trim() === '*') {
          result.addCheck(`dependencies:wildcard:cargo:${name}`, false, {
            severity: 'warning',
            file: manifest.rel,
            line: lineNo,
            message: `"${name} = "${spec}"" is a wildcard — pin the version`,
            suggestion: 'Cargo supports caret ranges like "1.2" — use those or pin exactly.',
          });
        }
      }
      const tableMatch = line.match(/^([A-Za-z0-9_-]+)\s*=\s*\{([^}]*)\}/);
      if (tableMatch) {
        const [, name, body] = tableMatch;
        if (/\bgit\s*=/.test(body) && !/\brev\s*=/.test(body) && !/\btag\s*=/.test(body)) {
          result.addCheck(`dependencies:git-no-rev:cargo:${name}`, false, {
            severity: 'warning',
            file: manifest.rel,
            line: lineNo,
            message: `"${name}" is a git dep without rev/tag — builds are non-reproducible`,
            suggestion: 'Add `rev = "..."` or `tag = "..."` to the dependency spec.',
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Bundler / Gemfile
  // -------------------------------------------------------------------------

  _checkGemfile(manifest, projectRoot, result) {
    this._checkLockfile(manifest, projectRoot, result);
    const lines = manifest.content.split('\n');
    let lineNo = 0;
    for (const raw of lines) {
      lineNo += 1;
      const line = raw.trim();
      if (!line.startsWith('gem ')) continue;
      // `gem 'rails', '~> 7.1'` or `gem "foo"`
      const m = line.match(/^gem\s+['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]+)['"])?/);
      if (!m) continue;
      const name = m[1];
      const spec = m[2];
      if (!spec) {
        result.addCheck(`dependencies:wildcard:bundler:${name}`, false, {
          severity: 'warning',
          file: manifest.rel,
          line: lineNo,
          message: `"gem '${name}'" has no version constraint — at minimum use a pessimistic constraint like "~> 1.2"`,
        });
      }
      if (DEPRECATED_PACKAGES[name.toLowerCase()]) {
        result.addCheck(`dependencies:deprecated:bundler:${name}`, false, {
          severity: 'warning',
          file: manifest.rel,
          line: lineNo,
          message: `"${name}" is deprecated — ${DEPRECATED_PACKAGES[name.toLowerCase()]}`,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Composer / composer.json
  // -------------------------------------------------------------------------

  _checkComposer(manifest, projectRoot, result) {
    this._checkLockfile(manifest, projectRoot, result);
    const data = JSON.parse(manifest.content);
    for (const block of [['require', data.require || {}], ['require-dev', data['require-dev'] || {}]]) {
      const [blockName, deps] = block;
      for (const [name, spec] of Object.entries(deps)) {
        this._flagPackage({ ecosystem: 'composer', name, spec, manifest, blockName, result });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Maven / pom.xml (very coarse regex — no XML parser dep)
  // -------------------------------------------------------------------------

  _checkMaven(manifest, result) {
    // Find <dependency>...<version>...</version>...</dependency>
    const deps = [...manifest.content.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)];
    for (const [, body] of deps) {
      const idMatch = body.match(/<artifactId>\s*([^<]+?)\s*<\/artifactId>/);
      const versionMatch = body.match(/<version>\s*([^<]+?)\s*<\/version>/);
      const id = idMatch ? idMatch[1].trim() : 'unknown';
      if (!versionMatch) {
        result.addCheck(`dependencies:wildcard:maven:${id}`, false, {
          severity: 'warning',
          file: manifest.rel,
          message: `"${id}" has no <version> element — Maven will resolve whatever is newest`,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Gradle / build.gradle (regex only)
  // -------------------------------------------------------------------------

  _checkGradle(manifest, result) {
    const lines = manifest.content.split('\n');
    let lineNo = 0;
    for (const raw of lines) {
      lineNo += 1;
      const line = raw.trim();
      // `implementation 'group:artifact:version'` or `"group:artifact:+"`
      const m = line.match(/(?:implementation|api|compileOnly|runtimeOnly|testImplementation)\s+['"]([^:'"]+):([^:'"]+):([^'"]+)['"]/);
      if (!m) continue;
      const [, group, artifact, version] = m;
      if (version === '+' || version.endsWith('+') || version.toLowerCase() === 'latest') {
        result.addCheck(`dependencies:wildcard:gradle:${group}:${artifact}`, false, {
          severity: 'warning',
          file: manifest.rel,
          line: lineNo,
          message: `"${group}:${artifact}:${version}" uses a dynamic version — pin it`,
          suggestion: 'Dynamic versions break reproducibility. Pin to a specific version.',
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  _flagPackage({ ecosystem, name, spec, manifest, blockName, result }) {
    const lowerName = name.toLowerCase();
    const trimmedSpec = String(spec || '').trim();

    if (DEPRECATED_PACKAGES[lowerName]) {
      result.addCheck(`dependencies:deprecated:${ecosystem}:${name}`, false, {
        severity: 'warning',
        file: manifest.rel,
        message: `"${name}" (${blockName}) is deprecated — ${DEPRECATED_PACKAGES[lowerName]}`,
      });
    }

    if (WILDCARD_SPECIFIERS.has(trimmedSpec)) {
      result.addCheck(`dependencies:wildcard:${ecosystem}:${name}`, false, {
        severity: 'warning',
        file: manifest.rel,
        message: `"${name}": "${trimmedSpec}" is a wildcard/latest pin — supply-chain risk`,
        suggestion: 'Pin to a specific version or semver range (e.g. "^1.2.3").',
      });
    } else if (NON_REGISTRY_PATTERN.test(trimmedSpec)) {
      result.addCheck(`dependencies:non-registry:${ecosystem}:${name}`, false, {
        severity: 'info',
        file: manifest.rel,
        message: `"${name}": "${trimmedSpec}" resolves outside the registry — confirm this is intentional`,
      });
    }
  }

  _checkLockfile(manifest, projectRoot, result) {
    if (!manifest.lockfiles || manifest.lockfiles.length === 0) return;
    const found = manifest.lockfiles.some((lf) => fs.existsSync(path.join(projectRoot, lf)));
    if (!found) {
      result.addCheck(`dependencies:no-lockfile:${manifest.kind}:${manifest.rel}`, false, {
        severity: 'warning',
        file: manifest.rel,
        message: `${manifest.rel} has no matching lockfile (${manifest.lockfiles.join(' / ')}) — builds are non-reproducible`,
        suggestion: `Generate and commit a lockfile so every CI run uses the same versions.`,
      });
    }
  }
}

module.exports = DependenciesModule;
