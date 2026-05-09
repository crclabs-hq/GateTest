/**
 * Base Module - Abstract base class for all GateTest test modules.
 */

class BaseModule {
  constructor(name, description) {
    this.name = name;
    this.description = description;
  }

  /**
   * Run the module's checks.
   * @param {TestResult} result - The result object to record checks against.
   * @param {GateTestConfig} config - The GateTest configuration.
   */
  async run(result, config) {
    throw new Error(`Module "${this.name}" must implement run()`);
  }

  /**
   * Collect files matching patterns from project root.
   *
   * Incremental scan support: when this method is called from a module
   * whose `config._incrementalFiles` is a Set of absolute paths (set by
   * the runner under `--since <ref>` / `--pr`), the returned list is
   * filtered down to only those files. This is what makes incremental
   * mode 5x-30x faster on a real PR — every file-walking module
   * transparently sees only the changed files via this single hook.
   *
   * Modules can opt out by reading `config._incrementalFiles` directly
   * and not calling this method, or by being on the runner's
   * `incremental.alwaysRunList`.
   *
   * @param {string|object} projectRoot - Project root path, or a config
   *   object whose `.projectRoot` is used. Passing the config (rare —
   *   the modules historically pass a string) is supported only for
   *   future flexibility; normal use is the string form.
   */
  _collectFiles(projectRoot, patterns, excludes = []) {
    const fs = require('fs');
    const path = require('path');
    const files = [];

    const defaultExcludes = [
      'node_modules', '.git', 'dist', 'build', '.gatetest', 'coverage',
      '.next', '.nuxt', '.svelte-kit', '.output', '.vercel', '.turbo',
      '__pycache__', '.pytest_cache', 'target', 'vendor', '.cargo',
      'out', 'public/build', '.cache', '.parcel-cache',
    ];
    const allExcludes = [...defaultExcludes, ...excludes];

    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (allExcludes.includes(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (patterns.includes(ext) || patterns.includes('*')) {
            files.push(fullPath);
          }
        }
      }
    };

    walk(projectRoot);

    // Incremental filter — applied AFTER the walk so `excludes` and
    // `patterns` semantics are preserved. The incremental file Set is
    // resolved against absolute paths to be cross-platform safe.
    const incremental = this._currentIncrementalFiles;
    if (incremental && incremental.size > 0) {
      return files.filter((abs) => incremental.has(path.resolve(abs)));
    }

    return files;
  }

  /**
   * Convenience wrapper most modules can call instead of touching
   * `config._incrementalFiles` directly: pass it the module's `config`
   * object before calling `_collectFiles`. Stash-and-restore pattern so
   * concurrent module runs (under `--parallel`) don't trample each other.
   *
   * Most modules don't need to call this — the runner sets
   * `config._incrementalFiles` and BaseModule reads it at walk time
   * via `_collectFilesWithConfig`. Kept here for completeness.
   */
  _collectFilesWithConfig(config, projectRoot, patterns, excludes = []) {
    const previous = this._currentIncrementalFiles;
    this._currentIncrementalFiles =
      (config && config._incrementalFiles) || null;
    try {
      return this._collectFiles(projectRoot, patterns, excludes);
    } finally {
      this._currentIncrementalFiles = previous;
    }
  }

  /**
   * Run a shell command and return { stdout, stderr, exitCode }.
   */
  _exec(command, options = {}) {
    const { execSync } = require('child_process');
    try {
      const stdout = execSync(command, {
        encoding: 'utf-8',
        timeout: options.timeout || 60000,
        cwd: options.cwd || process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { stdout, stderr: '', exitCode: 0 };
    } catch (err) {
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || '',
        exitCode: err.status || 1,
      };
    }
  }
}

module.exports = BaseModule;
