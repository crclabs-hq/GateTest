'use strict';

const { spawn } = require('child_process');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Log Streamer — captures output from a running process or log file.
// Three modes: command (spawn + capture), logFile (tail), pid (Linux /proc).
// No new npm dependencies.
// ---------------------------------------------------------------------------

const MAX_LINES = 500;
const MAX_SECONDS = 60;
const DEFAULT_SECONDS = 10;
const POLL_INTERVAL_MS = 250;

// ---------------------------------------------------------------------------
// Mode: command — spawn a command, capture stdout+stderr for N seconds
// ---------------------------------------------------------------------------

async function streamCommand(command, opts = {}) {
  const seconds = Math.min(opts.seconds || DEFAULT_SECONDS, MAX_SECONDS);
  const cwd = opts.cwd || process.cwd();
  const timeoutMs = seconds * 1000;

  const lines = [];
  let truncated = false;

  const parts = typeof command === 'string' ? command.split(/\s+/) : command;
  const cmd = parts[0];
  const args = parts.slice(1);

  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...(opts.env || {}) },
      shell: process.platform === 'win32',
    });

    const addLine = (stream, text) => {
      if (truncated) return;
      const ts = new Date().toISOString();
      for (const t of text.toString().split('\n')) {
        const trimmed = t.replace(/\r$/, '');
        if (!trimmed) continue;
        lines.push({ ts, stream, text: trimmed });
        if (lines.length >= MAX_LINES) { truncated = true; return; }
      }
    };

    child.stdout.on('data', (b) => addLine('stdout', b));
    child.stderr.on('data', (b) => addLine('stderr', b));

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000); // error-ok: best-effort stream cleanup; target may already be closed
    }, timeoutMs);

    const finish = (exitCode) => {
      clearTimeout(timer);
      resolve({ mode: 'command', lines, totalLines: lines.length, truncated, duration: seconds * 1000, exitCode });
    };

    child.on('close', finish);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        mode: 'command', lines, totalLines: lines.length, truncated, duration: 0,
        error: err.message,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Mode: logFile — tail a file path for N seconds, collecting new lines
// ---------------------------------------------------------------------------

async function streamLogFile(filePath, opts = {}) {
  const seconds = Math.min(opts.seconds || DEFAULT_SECONDS, MAX_SECONDS);
  const timeoutMs = seconds * 1000;
  const start = Date.now();

  const lines = [];
  let truncated = false;
  let lastSize = 0;

  // Start from end of file — same open-then-fstat idiom as the poll loop.
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      lastSize = fs.fstatSync(fd).size;
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return { mode: 'logFile', lines, totalLines: 0, truncated: false, duration: 0, error: `Cannot read file: ${err.message}` };
  }

  return new Promise((resolve) => {
    const poll = setInterval(() => {
      try {
        // Open first, fstat the fd — no TOCTOU window between the size
        // check and the read; both act on the same open file handle.
        const fd = fs.openSync(filePath, 'r');
        let buf;
        try {
          const stat = fs.fstatSync(fd);
          if (stat.size <= lastSize) return;
          const newBytes = stat.size - lastSize;
          buf = Buffer.alloc(newBytes);
          fs.readSync(fd, buf, 0, newBytes, lastSize);
          lastSize = stat.size;
        } finally {
          fs.closeSync(fd);
        }

        const ts = new Date().toISOString();
        for (const text of buf.toString('utf8').split('\n')) {
          const trimmed = text.replace(/\r$/, '');
          if (!trimmed) continue;
          lines.push({ ts, stream: 'file', text: trimmed });
          if (lines.length >= MAX_LINES) { truncated = true; break; }
        }
      } catch {} // error-ok: best-effort stream cleanup; target may already be closed
    }, POLL_INTERVAL_MS);

    setTimeout(() => {
      clearInterval(poll);
      resolve({ mode: 'logFile', lines, totalLines: lines.length, truncated, duration: Date.now() - start });
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// Mode: pid — read from /proc/{pid}/fd/1 (Linux only)
// ---------------------------------------------------------------------------

async function streamPid(pid, opts = {}) {
  if (process.platform !== 'linux') {
    return {
      mode: 'pid',
      lines: [],
      totalLines: 0,
      truncated: false,
      duration: 0,
      error: `PID mode is only supported on Linux (current platform: ${process.platform}). Use "command" or "logFile" mode instead.`,
    };
  }

  const fdPath = `/proc/${pid}/fd/1`;
  if (!fs.existsSync(fdPath)) {
    return {
      mode: 'pid', lines: [], totalLines: 0, truncated: false, duration: 0,
      error: `Process ${pid} not found or /proc/${pid}/fd/1 not accessible. Check the PID and that GateTest has read permission.`,
    };
  }

  // On Linux, we can tail /proc/PID/fd/1 which is a symlink to the process's stdout.
  // Use `tail -f` on it.
  return streamCommand(`tail -f /proc/${pid}/fd/1`, opts);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * streamLogs(opts) → Promise<StreamResult>
 *
 * opts.command  — spawn this command and capture its output
 * opts.logFile  — tail this file path
 * opts.pid      — attach to this process ID (Linux only)
 * opts.seconds  — capture duration (default 10, max 60)
 * opts.cwd      — working directory for command mode
 *
 * StreamResult: { mode, lines: [{ts, stream, text}], totalLines, truncated, duration, error? }
 */
async function streamLogs(opts = {}) {
  if (opts.command) return streamCommand(opts.command, opts);
  if (opts.logFile) return streamLogFile(opts.logFile, opts);
  if (opts.pid) return streamPid(Number(opts.pid), opts);
  return { mode: 'none', lines: [], totalLines: 0, truncated: false, duration: 0, error: 'Provide one of: command, logFile, or pid' };
}

module.exports = { streamLogs };
