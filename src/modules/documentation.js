/**
 * Documentation Module - Deep documentation quality validation.
 * Checks README completeness, API docs, env documentation, inline comments,
 * license compliance, and contribution guidelines.
 */

const BaseModule = require('./base-module');
const { hasRouteHandler } = require('../core/route-grammar');
const { JS_SOURCE_EXTS, JS_SOURCE_EXTS_NO_JSX } = require('../core/source-extensions');
const fs = require('fs');
const path = require('path');
const { repoRelative } = require('../core/repo-path');

class DocumentationModule extends BaseModule {
  constructor() {
    super('documentation', 'Documentation Validation');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;

    this._checkReadme(projectRoot, result);
    this._checkChangelog(projectRoot, result);
    this._checkEnvDocs(projectRoot, result);
    this._checkLicense(projectRoot, result);
    this._checkContributing(projectRoot, result);
    this._checkApiDocs(projectRoot, result);
    this._checkJsDocCoverage(projectRoot, result);
    this._checkDeadLinks(projectRoot, result);
  }

  _checkReadme(projectRoot, result) {
    // Case-sensitively `README.md` only. expressjs/express ships `Readme.md`
    // and got ships `readme.md` — both were reported as "no README", a
    // blocking error, on repos that plainly have one. GitHub, npm and every
    // other consumer of this file match it case-insensitively; so do we.
    const README_RE = /^readme(?:\.(?:md|markdown|rst|txt))?$/i;
    let readmeName = null;
    try {
      readmeName = fs.readdirSync(projectRoot).find((f) => README_RE.test(f)) || null;
    } catch { readmeName = null; }
    const readmePath = path.join(projectRoot, readmeName || 'README.md');
    if (!readmeName || !fs.existsSync(readmePath)) {
      // WARNING, not error: a missing README is a real quality signal, but no
      // build is broken by it, and a gate that blocks on documentation is the
      // bottleneck (Forbidden #25; lodash blocked on a README section in
      // #418's corpus run, 2026-09-02). Same for the section checks below.
      result.addCheck('docs:readme', false, {
        severity: 'warning',
        message: 'No README found',
        suggestion: 'Create a README.md with project description, setup, and usage instructions',
      });
      return;
    }

    const content = fs.readFileSync(readmePath, 'utf-8');
    const lower = content.toLowerCase();

    // Check for essential sections
    const requiredSections = [
      // warning, not error: a README that lacks an install section is hygiene,
      // not a defect. axum, laravel and vapor were all BLOCKED on it
      // (2026-09-05) — the gate as bottleneck, Forbidden #25.
      { name: 'setup/install', keywords: ['install', 'setup', 'getting started', 'quick start'], severity: 'warning' },
      { name: 'usage', keywords: ['usage', 'how to use', 'example', 'quick start'], severity: 'warning' },
      { name: 'description', keywords: ['##', '# '], severity: 'warning' },
    ];

    const recommendedSections = [
      { name: 'api/reference', keywords: ['api', 'reference', 'documentation', 'endpoints'], severity: 'warning' },
      { name: 'contributing', keywords: ['contributing', 'contribute', 'development'], severity: 'warning' },
      { name: 'license', keywords: ['license', 'mit', 'apache', 'gpl'], severity: 'warning' },
    ];

    for (const section of requiredSections) {
      const found = section.keywords.some(k => lower.includes(k));
      if (!found) {
        result.addCheck(`docs:readme-${section.name}`, false, {
          file: 'README.md',
          severity: section.severity,
          message: `README lacks ${section.name} section`,
          suggestion: `Add a ${section.name} section to README.md`,
        });
      }
    }

    for (const section of recommendedSections) {
      const found = section.keywords.some(k => lower.includes(k));
      if (!found) {
        result.addCheck(`docs:readme-${section.name}`, false, {
          file: 'README.md',
          severity: section.severity,
          message: `README missing recommended section: ${section.name}`,
          suggestion: `Consider adding a ${section.name} section`,
        });
      }
    }

    // Check README isn't a skeleton
    if (content.length < 200) {
      result.addCheck('docs:readme-substance', false, {
        file: 'README.md',
        severity: 'warning',
        message: `README is only ${content.length} characters — likely a skeleton`,
        suggestion: 'Flesh out the README with real project information',
      });
    } else {
      result.addCheck('docs:readme', true);
    }

    // Check for broken relative links in README
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    let match;
    while ((match = linkRegex.exec(content)) !== null) {
      const href = match[2];
      if (href.startsWith('http') || href.startsWith('#') || href.startsWith('mailto:')) continue;
      const target = path.resolve(projectRoot, href);
      if (!fs.existsSync(target)) {
        result.addCheck(`docs:readme-link:${href}`, false, {
          file: 'README.md',
          severity: 'warning',
          message: `Broken link in README: [${match[1]}](${href})`,
          suggestion: `File not found: ${href}`,
        });
      }
    }
  }

  _checkChangelog(projectRoot, result) {
    const changelogFiles = ['CHANGELOG.md', 'CHANGES.md', 'HISTORY.md'];
    const found = changelogFiles.find(f => fs.existsSync(path.join(projectRoot, f)));

    if (!found) {
      result.addCheck('docs:changelog', false, {
        severity: 'warning',
        message: 'No CHANGELOG.md found',
        suggestion: 'Create a CHANGELOG.md to track user-facing changes',
      });
    } else {
      const content = fs.readFileSync(path.join(projectRoot, found), 'utf-8');
      // Check it has actual version entries
      const versionPattern = /##\s+\[?\d+\.\d+/;
      if (!versionPattern.test(content)) {
        result.addCheck('docs:changelog-content', false, {
          file: found,
          severity: 'warning',
          message: 'CHANGELOG exists but has no version entries',
          suggestion: 'Add version entries in format: ## [1.0.0] - 2024-01-01',
        });
      } else {
        result.addCheck('docs:changelog', true);
      }
    }
  }

  _checkEnvDocs(projectRoot, result) {
    const envExample = ['.env.example', '.env.sample', '.env.template'];
    const hasEnv = fs.existsSync(path.join(projectRoot, '.env'));
    const hasExample = envExample.some(f => fs.existsSync(path.join(projectRoot, f)));

    if (hasEnv && !hasExample) {
      result.addCheck('docs:env-example', false, {
        severity: 'error',
        message: '.env file exists but no .env.example for documentation',
        suggestion: 'Create .env.example with all required variables (without values)',
      });
    }

    // Check for env vars referenced in code but not documented
    const jsFiles = this._collectFiles(projectRoot, JS_SOURCE_EXTS);
    const envVarsUsed = new Set();

    for (const file of jsFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const envPattern = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
      let match;
      while ((match = envPattern.exec(content)) !== null) {
        envVarsUsed.add(match[1]);
      }
    }

    if (envVarsUsed.size > 0 && !hasExample) {
      result.addCheck('docs:env-vars-undocumented', false, {
        severity: 'warning',
        message: `${envVarsUsed.size} env vars used in code but no .env.example: ${Array.from(envVarsUsed).slice(0, 5).join(', ')}`,
        suggestion: 'Create .env.example documenting all required environment variables',
      });
    }
  }

  _checkLicense(projectRoot, result) {
    const licenseFiles = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md'];
    const found = licenseFiles.some(f => fs.existsSync(path.join(projectRoot, f)));

    if (!found) {
      // Check package.json for license field
      const pkgPath = path.join(projectRoot, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          if (!pkg.license) {
            result.addCheck('docs:license', false, {
              severity: 'warning',
              message: 'No LICENSE file and no license field in package.json',
              suggestion: 'Add a LICENSE file or license field to package.json',
            });
            return;
          }
        } catch { /* ignore */ }
      }
    }

    result.addCheck('docs:license', true);
  }

  _checkContributing(projectRoot, result) {
    const contributingFiles = ['CONTRIBUTING.md', 'CONTRIBUTE.md', '.github/CONTRIBUTING.md'];
    const found = contributingFiles.some(f => fs.existsSync(path.join(projectRoot, f)));

    if (!found) {
      result.addCheck('docs:contributing', false, {
        severity: 'info',
        message: 'No CONTRIBUTING.md found',
        suggestion: 'Consider adding contribution guidelines for open-source projects',
      });
    } else {
      result.addCheck('docs:contributing', true);
    }
  }

  _checkApiDocs(projectRoot, result) {
    // Check for API documentation files
    const apiDocPaths = [
      'docs/api', 'doc/api', 'API.md', 'docs/API.md',
      'openapi.yaml', 'openapi.json', 'swagger.yaml', 'swagger.json',
    ];

    const found = apiDocPaths.some(p => fs.existsSync(path.join(projectRoot, p)));

    // Only flag if there are API routes
    const hasApiRoutes = this._hasApiRoutes(projectRoot);

    if (hasApiRoutes && !found) {
      result.addCheck('docs:api', false, {
        severity: 'warning',
        message: 'API routes found but no API documentation',
        suggestion: 'Add OpenAPI/Swagger spec or API.md documenting endpoints',
      });
    }
  }

  _hasApiRoutes(projectRoot) {
    const jsFiles = this._collectFiles(projectRoot, JS_SOURCE_EXTS);
    for (const file of jsFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      // Shared route grammar (src/core/route-grammar.js): a Fastify, Hono,
      // Koa or NestJS API with no docs used to pass as "no API here".
      if (hasRouteHandler(content)) return true;
    }
    return false;
  }

  _checkJsDocCoverage(projectRoot, result) {
    const jsFiles = this._collectFiles(projectRoot, JS_SOURCE_EXTS_NO_JSX);
    let totalFunctions = 0;
    let documentedFunctions = 0;

    for (const file of jsFiles) {
      const relPath = repoRelative(projectRoot, file);
      // Skip test files and generated files
      if (this._isTestPath(relPath) || relPath.includes('.min.')) continue;

      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Detect function declarations
        if (line.match(/^\s*(async\s+)?function\s+\w+|^\s*(async\s+)?\w+\s*\(.*\)\s*{|^\s*(static\s+)?(async\s+)?\w+\s*\(.*\)\s*{/)) {
          totalFunctions++;
          // Check if previous lines contain JSDoc
          let hasDoc = false;
          for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
            if (lines[j].trim().startsWith('*/')) { hasDoc = true; break; }
            if (lines[j].trim() && !lines[j].trim().startsWith('*') && !lines[j].trim().startsWith('//')) break;
          }
          if (hasDoc) documentedFunctions++;
        }
      }
    }

    if (totalFunctions > 0) {
      const coverage = Math.round((documentedFunctions / totalFunctions) * 100);
      result.addCheck('docs:jsdoc-coverage', coverage >= 30, {
        severity: coverage >= 30 ? 'info' : 'warning',
        message: `JSDoc coverage: ${coverage}% (${documentedFunctions}/${totalFunctions} functions documented)`,
        suggestion: coverage < 30 ? 'Add JSDoc comments to exported functions' : undefined,
      });
    }
  }

  _checkDeadLinks(projectRoot, result) {
    const mdFiles = this._collectFiles(projectRoot, ['.md']);
    let brokenCount = 0;

    for (const file of mdFiles) {
      const relPath = repoRelative(projectRoot, file);
      const content = fs.readFileSync(file, 'utf-8');
      const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
      let match;

      while ((match = linkRegex.exec(content)) !== null) {
        const href = match[2];
        // Only check relative links
        if (href.startsWith('http') || href.startsWith('#') || href.startsWith('mailto:')) continue;
        const target = path.resolve(path.dirname(file), href.split('#')[0]);
        if (!fs.existsSync(target)) {
          brokenCount++;
          if (brokenCount <= 5) {
            result.addCheck(`docs:dead-link:${relPath}:${match[1]}`, false, {
              file: relPath,
              severity: 'warning',
              message: `Broken link: [${match[1]}](${href})`,
              suggestion: `Target not found: ${href}`,
            });
          }
        }
      }
    }

    if (brokenCount === 0) {
      result.addCheck('docs:links', true, { severity: 'info' });
    }
  }
}

module.exports = DocumentationModule;
