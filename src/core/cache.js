/**
 * GateTest Cache - Skips re-checking unchanged files.
 * Uses content hashes (SHA-256) to detect changes.
 * Cache is stored in .gatetest/cache.json.
 */

const fs = require('fs');
const path = require('path');
const { repoRelative } = require('./repo-path');
const crypto = require('crypto');

class GateTestCache {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.cachePath = path.join(projectRoot, '.gatetest', 'cache.json');
    this.cache = this._load();
  }

  /**
   * Check if a file has changed since last scan.
   * @returns {boolean} true if file is new or changed, false if unchanged.
   */
  hasChanged(filePath) {
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(this.projectRoot, filePath);
    try {
      const content = fs.readFileSync(absPath);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      const relPath = repoRelative(this.projectRoot, absPath);
      const cached = this.cache.files[relPath];
      return !cached || cached.hash !== hash;
    } catch {
      return true; // File unreadable = treat as changed
    }
  }

  /**
   * Update the cache entry for a file.
   */
  update(filePath) {
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(this.projectRoot, filePath);
    try {
      const content = fs.readFileSync(absPath);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      const stat = fs.statSync(absPath);
      const relPath = repoRelative(this.projectRoot, absPath);

      this.cache.files[relPath] = {
        hash,
        size: stat.size,
        mtime: stat.mtimeMs,
        lastChecked: Date.now(),
      };
    } catch {
      // Skip unreadable files
    }
  }

  /**
   * Filter a list of files down to only those that have changed.
   */
  filterChanged(filePaths) {
    return filePaths.filter(f => this.hasChanged(f));
  }

  /**
   * Save cache to disk.
   */
  save() {
    const dir = path.dirname(this.cachePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.cache.lastSaved = Date.now();
    this.cache.version = '1.0';
    fs.writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2));
  }

  /**
   * Clear the cache.
   */
  clear() {
    this.cache = { version: '1.0', files: {}, lastSaved: null };
    // Atomic delete — catch ENOENT instead of pre-checking (avoids
    // TOCTOU where a concurrent process unlinks the file between
    // `existsSync` and `unlinkSync`, crashing this process).
    try {
      fs.unlinkSync(this.cachePath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  /**
   * Get cache statistics.
   */
  stats() {
    const entries = Object.keys(this.cache.files).length;
    return {
      entries,
      lastSaved: this.cache.lastSaved ? new Date(this.cache.lastSaved).toISOString() : null,
    };
  }

  _load() {
    try {
      if (fs.existsSync(this.cachePath)) {
        return JSON.parse(fs.readFileSync(this.cachePath, 'utf-8'));
      }
    } catch {
      // Corrupt cache — start fresh
    }
    return { version: '1.0', files: {}, lastSaved: null };
  }
}

module.exports = { GateTestCache };
