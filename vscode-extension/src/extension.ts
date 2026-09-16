/**
 * GateTest VS Code Extension
 *
 * Native VS Code / Cursor / Windsurf integration.
 * - Runs the GateTest engine IN-PROCESS (a worker thread inside the extension
 *   host) and shows findings as inline diagnostics — no CLI on PATH, no
 *   child process, no JSON-over-stdout.
 * - Sidebar panel for issues, status bar showing scan state
 * - One command to configure the MCP server for AI coding tools
 * - Runs `gatetest --format json` and shows findings as inline diagnostics
 * - Status bar showing scan state
 * - Commands that register the GateTest MCP server with AI coding tools —
 *   on request, never at startup (an extension must not edit settings on
 *   activation)
 *
 * The CLI contract this file consumes is `gatetest --format json`
 * (src/core/json-output.js in the CLI repository, `gatetest --help`).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Worker } from 'worker_threads';

// ─── Engine bridge (plain CommonJS, shared with the repo's node:test suite) ──

interface DiagnosticRecord {
  file: string | null;
  line: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  module: string;
  rule: string | null;
  suggestion: string | null;
  blocking: boolean;
  ignoreLine: string | null;
}

interface EngineSummary {
  gateStatus: 'PASSED' | 'BLOCKED';
  nothingChecked: boolean;
  findings: unknown[];
  deferred: string[];
  modules: { total?: number; passed?: number; failed?: number; skipped?: number };
  checks: { blockingErrors?: number; warnings?: number; errors?: number };
  duration: number;
  results: { module: string; status: string; duration?: number; checks: number }[];
}

interface EngineBridge {
  EDITOR_SKIP_MODULES: string[];
  resolveEngineEntry(input: { configuredPath?: string; workspaceRoot?: string; extensionDir?: string }): {
    entry: string | null;
    version: string | null;
    source: string | null;
    attempts?: { source: string; path: string; ok: boolean }[];
  };
  findingsToDiagnostics(summary: EngineSummary, root: string, opts?: { onlyFile?: string }): {
    inFiles: DiagnosticRecord[];
    repoLevel: DiagnosticRecord[];
  };
  summarize(summary: EngineSummary, opts?: { onlyFile?: string; inFilesCount?: number }): {
    passed: boolean;
    errors: number;
    warnings: number;
    text: string;
  };
}

type WorkerMessage =
  | { type: 'progress'; event: string; payload?: { module?: string; status?: string; duration?: number; count?: number } }
  | { type: 'log'; level: string; text: string }
  | { type: 'done'; summary: EngineSummary }
  | { type: 'error'; message: string; stack?: string };
// ─── Types — the `gatetest --format json` document ───────────────────────────

type Severity = 'error' | 'warning' | 'info';

interface GateTestIssue {
  id: string;
  module: string;
  ruleId: string | null;
  severity: Severity;
  message: string;
  /** repo-relative, '/'-joined; null for a repo-level finding (no file) */
  file: string | null;
  /** 1-based; null when the module gave none */
  line: number | null;
  /** 1-based; null when the module gave none */
  column: number | null;
  blocking: boolean;
  confidence: number | null;
  fixable: boolean;
  suggestion: string | null;
  ignoreLine: string | null;
}

interface ScanResult {
  version: string;
  generatedAt: string;
  suite: string | null;
  module: string | null;
  project: string;
  files: string[] | null;
  passed: boolean;
  gateStatus: 'PASSED' | 'BLOCKED';
  exitCode: number;
  nothingChecked: boolean;
  summary: string;
  counts: { errors: number; warnings: number; notes: number; blocking: number; total: number; duplicatesCollapsed: number };
  modules: { total: number; passed: number; failed: number; skipped: number };
  duration: number | null;
  deferred: string[];
  report: string | null;
  issues: GateTestIssue[];
}

/** How to launch the CLI: command + leading args, resolved per scan. */
interface CliLaunch {
  command: string;
  args: string[];
  shell: boolean;
  env?: NodeJS.ProcessEnv;
  /** Where the CLI's bin/ directory is, when known (for the MCP server next to it). */
  binDir: string | null;
  description: string;
}

const INSTALL_HINT =
  'GateTest CLI not found. Install it with: npm install -g @gatetest/cli ' +
  '(or npm install -D @gatetest/cli in this workspace), or set "gatetest.gatePath" to the CLI.';

// ─── Extension state ─────────────────────────────────────────────────────────

let diagnosticCollection: vscode.DiagnosticCollection;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let extensionDir = '';
let bridge: EngineBridge;
let activeWorker: Worker | null = null;

// ─── Activate ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  extensionDir = context.extensionPath;
  // Plain CommonJS on purpose: the bridge is shared with the repo's node:test
  // suite, which loads it without compiling the extension.
  bridge = require(path.join(extensionDir, 'engine', 'engine-bridge.js')) as EngineBridge;

  diagnosticCollection = vscode.languages.createDiagnosticCollection('gatetest');
  outputChannel = vscode.window.createOutputChannel('GateTest');
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'gatetest.showPanel';
  setStatus('idle');
  statusBarItem.show();

  context.subscriptions.push(
    diagnosticCollection,
    statusBarItem,
    outputChannel,
    vscode.commands.registerCommand('gatetest.scanWorkspace', () => runScan('quick')),
    vscode.commands.registerCommand('gatetest.scanFull', () => runScan('full')),
    vscode.commands.registerCommand('gatetest.scanFile', scanCurrentFile),
    vscode.commands.registerCommand('gatetest.cancelScan', cancelScan),
    vscode.commands.registerCommand('gatetest.fixIssues', openFixDashboard),
    vscode.commands.registerCommand('gatetest.showPanel', showPanel),
    vscode.commands.registerCommand('gatetest.setupMcp', setupMcpServer),
    vscode.commands.registerCommand('gatetest.addWorkspaceMcp', addWorkspaceMcp),
    vscode.commands.registerCommand('gatetest.openDashboard', openDashboard),
  );

  // Auto-scan on save if configured
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const cfg = vscode.workspace.getConfiguration('gatetest');
      if (cfg.get<boolean>('autoScanOnSave')) {
        void runScan('quick', doc.uri.fsPath);
      }
    })
  );

  const engine = resolveEngine();
  outputChannel.appendLine(
    engine.entry
      ? `[GateTest] engine ${engine.version} (${engine.source}) — ${engine.entry}`
      : '[GateTest] engine not found — set gatetest.enginePath or reinstall the extension'
  );
  // Nothing else happens at activation: no settings are written, no config
  // file is touched. MCP registration is the two commands above.
}

export function deactivate() {
  cancelScan();
  diagnosticCollection?.dispose();
  statusBarItem?.dispose();
}

// ─── Engine resolution ────────────────────────────────────────────────────────

function resolveEngine() {
  const configured = vscode.workspace.getConfiguration('gatetest').get<string>('enginePath', '');
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return bridge.resolveEngineEntry({ configuredPath: configured, workspaceRoot: root, extensionDir });
}

// ─── IDE setup command ────────────────────────────────────────────────────────

async function setupMcpServer() {
  // The MCP server ships as its own npm package; every client below can run
  // it through npx with no global install and no path to a binary.
  const mcpEntry = {
    command: 'npx',
    args: ['-y', '@gatetest/mcp-server'],
// ─── Locating the CLI ─────────────────────────────────────────────────────────

const CLI_REL = path.join('node_modules', '@gatetest', 'cli', 'bin', 'gatetest.js');

/**
 * A JS entry point is run under the extension host's own Node — that is
 * `process.execPath`, which is Electron here, so ELECTRON_RUN_AS_NODE makes
 * it behave as `node` instead of opening a window. Never spawn a bare .js:
 * on Windows that is EINVAL (or the file opens in an editor), on POSIX it
 * depends on a shebang and the mode bits.
 */
function launchForScript(script: string): CliLaunch {
  return {
    command: process.execPath,
    args: [script],
    shell: false,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    binDir: path.dirname(script),
    description: `${process.execPath} ${script}`,
  };
}

/** The CLI script behind an npm shim (`<prefix>/gatetest`, `<prefix>\gatetest.cmd`), if it is there. */
function scriptBehindShim(shim: string): string | null {
  const candidates = [
    path.join(path.dirname(shim), CLI_REL),                 // Windows global prefix: shim next to node_modules
    path.join(path.dirname(shim), '..', 'lib', CLI_REL),   // POSIX global prefix: bin/ next to lib/
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    const real = fs.realpathSync(shim);                    // POSIX: the shim is a symlink to the script
    if (/\.(c|m)?js$/i.test(real)) return real;
  } catch {
    // error-ok — not a symlink (or gone); the shim is used as-is below
  }
  return null;
}

/** Turn a configured or discovered path into something spawn() can run on this OS. */
function launchFor(p: string): CliLaunch {
  if (/\.(c|m)?js$/i.test(p)) return launchForScript(p);
  const behind = scriptBehindShim(p);
  if (behind) return launchForScript(behind);
  const isCmdShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(p);
  if (process.platform === 'win32' && !path.extname(p) && fs.existsSync(`${p}.cmd`)) {
    return launchFor(`${p}.cmd`);
  }
  return {
    command: p,
    args: [],
    // A .cmd shim cannot be spawned directly (Node refuses with EINVAL);
    // it needs cmd.exe. Only shims get a shell — a real binary does not.
    shell: isCmdShim,
    binDir: null,
    description: p,
  };
}

function writeIdeMcpConfig(ide: string, entry: unknown): boolean {
  const home = os.homedir();
  const configPaths: Record<string, string[]> = {
    claude:   [path.join(home, '.claude.json')],
    cursor:   [
      path.join(home, '.cursor', 'mcp.json'),
      path.join(home, '.config', 'Cursor', 'User', 'mcp.json'),
    ],
    windsurf: [path.join(home, '.codeium', 'windsurf', 'mcp_config.json')],
    cline:    [path.join(home, '.cline', 'mcp_servers.json')],
    zed:      [path.join(home, '.config', 'zed', 'settings.json')],
  };

  const targets = configPaths[ide];
  if (!targets) return false;

  for (const configPath of targets) {
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      let existing: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      }

      // Each IDE uses a slightly different schema
      if (ide === 'zed') {
        (existing as Record<string, unknown>)['context_servers'] ??= {};
        ((existing as Record<string, unknown>)['context_servers'] as Record<string, unknown>)['gatetest'] = entry;
      } else {
        // claude, cursor, windsurf, cline all use mcpServers at root
        (existing as Record<string, unknown>)['mcpServers'] ??= {};
        ((existing as Record<string, unknown>)['mcpServers'] as Record<string, unknown>)['gatetest'] = entry;
      }
function whichGatetest(): Promise<string | null> {
  return new Promise((resolve) => {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    cp.execFile(finder, ['gatetest'], { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) return resolve(null);
      const cmd = lines.find((l) => /\.cmd$/i.test(l));
      resolve(process.platform === 'win32' && cmd ? cmd : lines[0]);
    });
  });
}

/**
 * Resolution order: the configured path, the workspace's own install
 * (`node_modules/@gatetest/cli`), then whatever `gatetest` is on PATH.
 */
async function resolveCli(root: string): Promise<CliLaunch | null> {
  const configured = (vscode.workspace.getConfiguration('gatetest').get<string>('gatePath', 'gatetest') || '').trim();
  if (configured && configured !== 'gatetest') {
    const abs = path.isAbsolute(configured) ? configured : path.join(root, configured);
    return launchFor(abs);
  }
  const local = path.join(root, CLI_REL);
  if (fs.existsSync(local)) return launchForScript(local);
  const onPath = await whichGatetest();
  return onPath ? launchFor(onPath) : null;
}

// ─── Scan logic ───────────────────────────────────────────────────────────────

async function runScan(suite: string, targetFile?: string) {
  if (activeWorker) {
    void vscode.window.showWarningMessage('A GateTest scan is already running.', 'Cancel it').then((choice) => {
      if (choice === 'Cancel it') cancelScan();
    });
    return;
  }

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    void vscode.window.showErrorMessage('Open a workspace folder first.');
    return;
  }

  const engine = resolveEngine();
  if (!engine.entry) {
    const tried = (engine.attempts || []).map((a) => `  ${a.source}: ${a.path}`).join('\n');
    outputChannel.appendLine(`[GateTest] engine not found. Tried:\n${tried}`);
    void vscode.window.showErrorMessage(
      'GateTest engine not found. Set "gatetest.enginePath" to a GateTest checkout or an installed @gatetest/cli, or reinstall the extension.',
      'Open Settings'
    ).then((choice) => {
      if (choice === 'Open Settings') void vscode.commands.executeCommand('workbench.action.openSettings', 'gatetest.enginePath');
    });
  const launch = await resolveCli(root);
  if (!launch) {
    void vscode.window.showErrorMessage(INSTALL_HINT);
    return;
  }

  setStatus('scanning');
  outputChannel.clear();
  outputChannel.show(true);
  const scope = targetFile ? ` — ${path.relative(root, targetFile)}` : '';
  outputChannel.appendLine(`[GateTest] ${suite} scan${scope} · engine ${engine.version} (${engine.source})`);

  const changedFiles = targetFile ? [path.relative(root, targetFile)] : undefined;

  try {
    const summary = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `GateTest: ${suite} scan`, cancellable: true },
      (progress, token) => runEngineInWorker({
        entry: engine.entry as string,
        root,
        suite,
        changedFiles,
        skipModules: bridge.EDITOR_SKIP_MODULES,
      }, progress, token)
    );

    const { inFiles, repoLevel } = bridge.findingsToDiagnostics(summary, root, { onlyFile: targetFile });
    applyDiagnostics(inFiles);
    const verdict = bridge.summarize(summary, { onlyFile: targetFile, inFilesCount: inFiles.length });

    outputChannel.appendLine(`[GateTest] ${verdict.text} · ${Math.round(summary.duration / 1000)}s`);
    for (const r of repoLevel) {
      outputChannel.appendLine(`  [${r.severity}] ${r.module}: ${r.message}`);
    }

    setStatus(verdict.passed ? 'passed' : 'failed', inFiles.length);
    if (!verdict.passed) {
      void vscode.window.showWarningMessage(
        `GateTest: ${verdict.errors} blocking finding(s). Check the Problems panel.`,
  outputChannel.appendLine(`[GateTest] Starting ${suite} scan${targetFile ? ` of ${targetFile}` : ''}…`);
  outputChannel.appendLine(`[GateTest] CLI: ${launch.description}`);

  const args = [
    '--suite', suite,
    '--format', 'json',
    '--project', root,
    ...(targetFile ? ['--file', targetFile] : []),
  ];

  try {
    const { code, stdout, stderr } = await runProcess(launch, args, root);
    let parsed: ScanResult;
    try {
      parsed = JSON.parse(stdout) as ScanResult;
    } catch {
      setStatus('error');
      const tail = stderr.trim().split('\n').slice(-4).join('\n');
      outputChannel.appendLine(`[GateTest] The CLI did not return a JSON document (exit code ${code}).`);
      if (tail) outputChannel.appendLine(tail);
      if (stdout.trim()) outputChannel.appendLine(stdout.trim().slice(0, 2000));
      void vscode.window.showErrorMessage(
        code === 2
          ? 'GateTest: the CLI rejected the command line — see the GateTest output channel.'
          : 'GateTest: the CLI did not return JSON. Update it (npm install -g @gatetest/cli) — this extension needs a CLI with --format json (see gatetest --help).'
      );
      return;
    }

    applyDiagnostics(root, parsed.issues);
    setStatus(parsed.passed ? 'passed' : 'failed', parsed.counts.total);
    outputChannel.appendLine(`[GateTest] ${parsed.summary}`);
    if (parsed.deferred.length) outputChannel.appendLine(`[GateTest] Not run by this suite: ${parsed.deferred.join(', ')}`);
    if (parsed.report) outputChannel.appendLine(`[GateTest] Full report: ${parsed.report}`);
    if (parsed.exitCode !== code) outputChannel.appendLine(`[GateTest] Note: process exit code ${code} differs from the document's ${parsed.exitCode}.`);

    if (!parsed.passed) {
      void vscode.window.showWarningMessage(
        `GateTest: ${parsed.counts.errors} error(s), ${parsed.counts.warnings} warning(s). See the Problems panel.`,
        'Fix with AI'
      ).then((choice) => {
        if (choice === 'Fix with AI') void openFixDashboard();
      });
    } else if (summary.nothingChecked) {
      void vscode.window.showWarningMessage('GateTest: nothing was checked — no source files found under the workspace root.');
    } else if (parsed.nothingChecked) {
      void vscode.window.showWarningMessage('GateTest: no source files found under the workspace root — nothing was checked.');
    } else {
      void vscode.window.showInformationMessage(
        parsed.counts.total > 0
          ? `GateTest: gate passed with ${parsed.counts.total} non-blocking finding(s).`
          : 'GateTest: All checks passed'
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'cancelled') {
      setStatus('idle');
      outputChannel.appendLine('[GateTest] scan cancelled');
    } else {
      setStatus('error');
      outputChannel.appendLine(`[GateTest] Scan error: ${message}`);
    }
  }
}

function runEngineInWorker(
  data: { entry: string; root: string; suite: string; changedFiles?: string[]; skipModules: string[] },
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
): Promise<EngineSummary> {
  return new Promise<EngineSummary>((resolve, reject) => {
    const worker = new Worker(path.join(extensionDir, 'engine', 'engine-worker.js'), { workerData: data });
    activeWorker = worker;
    let settled = false;
    let total = 0;
    let finished = 0;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      activeWorker = null;
      fn();
    };

    token.onCancellationRequested(() => {
      void worker.terminate();
      finish(() => reject(new Error('cancelled')));
    });

    worker.on('message', (msg: WorkerMessage) => {
      switch (msg.type) {
        case 'progress':
          if (msg.event === 'suite:start' && msg.payload?.count) total = msg.payload.count;
          if (msg.event === 'module:start' && msg.payload?.module) {
            progress.report({ message: msg.payload.module });
          }
          if ((msg.event === 'module:end' || msg.event === 'module:skip') && total > 0) {
            finished += 1;
            progress.report({ increment: 100 / total });
          }
          if (msg.event === 'module:end' && msg.payload?.module) {
            outputChannel.appendLine(`  ${msg.payload.status === 'FAIL' ? '✗' : '✓'} ${msg.payload.module}${msg.payload.duration ? ` (${msg.payload.duration}ms)` : ''}`);
          }
          break;
        case 'log':
          if (msg.level === 'warn' || msg.level === 'error') outputChannel.appendLine(`  [${msg.level}] ${msg.text}`);
          break;
        case 'done':
          finish(() => resolve(msg.summary));
          break;
        case 'error':
          finish(() => reject(new Error(msg.message)));
          break;
      }
    });
    worker.on('error', (err) => finish(() => reject(err)));
    worker.on('exit', (code) => {
      if (code !== 0) finish(() => reject(new Error(`engine worker exited with code ${code}`)));
      else finish(() => reject(new Error('engine worker exited before reporting a result')));
    });
  });
}

function cancelScan() {
  if (activeWorker) {
    void activeWorker.terminate();
    activeWorker = null;
    setStatus('idle');
    setStatus('error');
    outputChannel.appendLine(`[GateTest] Scan error: ${err instanceof Error ? err.message : String(err)}`);
    void vscode.window.showErrorMessage('GateTest: the scan could not run — see the GateTest output channel.');
  } finally {
    scanInProgress = false;
  }
}

async function scanCurrentFile() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  await runScan('quick', editor.document.uri.fsPath);
}

function applyDiagnostics(records: DiagnosticRecord[]) {
  diagnosticCollection.clear();
  const byFile = new Map<string, vscode.Diagnostic[]>();
  const repoLevel: GateTestIssue[] = [];

  for (const rec of records) {
    if (!rec.file) continue;
    const uri = vscode.Uri.file(rec.file);
    const key = uri.toString();

    const line = Math.max(0, rec.line - 1);
    const range = new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);
  for (const issue of issues) {
    if (!issue.file) {
      repoLevel.push(issue);
      continue;
    }
    const absPath = path.isAbsolute(issue.file) ? issue.file : path.join(root, issue.file);
    const uri = vscode.Uri.file(absPath);
    const key = uri.toString();

    // The CLI reports 1-based lines/columns (null = unknown); VS Code is 0-based.
    const line = Math.max(0, (issue.line ?? 1) - 1);
    const col = Math.max(0, (issue.column ?? 1) - 1);
    // No end column is known — run to the end of the line; VS Code clamps it.
    const range = new vscode.Range(line, col, line, Number.MAX_SAFE_INTEGER);

    const severity =
      rec.severity === 'error' ? vscode.DiagnosticSeverity.Error :
      rec.severity === 'warning' ? vscode.DiagnosticSeverity.Warning :
      vscode.DiagnosticSeverity.Information;

    const text = rec.suggestion ? `${rec.message}\nFix: ${rec.suggestion}` : rec.message;
    const diag = new vscode.Diagnostic(range, text, severity);
    diag.source = `GateTest [${rec.module}]`;
    if (rec.rule) diag.code = rec.rule;
    const text = issue.suggestion ? `${issue.message} — ${issue.suggestion}` : issue.message;
    const diag = new vscode.Diagnostic(range, text, severity);
    diag.source = `GateTest (${issue.module})`;
    if (issue.ruleId) diag.code = issue.ruleId;

    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key)!.push(diag);
  }

  for (const [uriStr, diags] of byFile) {
    diagnosticCollection.set(vscode.Uri.parse(uriStr), diags);
  }

  if (repoLevel.length) {
    outputChannel.appendLine(`[GateTest] ${repoLevel.length} repository-level finding(s) with no file:`);
    for (const i of repoLevel) outputChannel.appendLine(`  [${i.severity}] ${i.module}: ${i.message}`);
  }
}

// ─── MCP server registration (on request only) ───────────────────────────────

/** `node <bin>/gatetest-mcp.mjs` when the CLI's bin/ is known, else the `gatetest-mcp` shim on PATH. */
async function resolveMcpEntry(root: string): Promise<{ command: string; args: string[] } | null> {
  const launch = await resolveCli(root);
  if (!launch) return null;
  if (launch.binDir) {
    const mcp = path.join(launch.binDir, 'gatetest-mcp.mjs');
    if (fs.existsSync(mcp)) return { command: 'node', args: [mcp] };
  }
  return { command: 'gatetest-mcp', args: [] };
}

/** Write `.vscode/mcp.json` in the workspace — the file VS Code reads MCP servers from. */
async function addWorkspaceMcp() {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    void vscode.window.showErrorMessage('Open a workspace folder first.');
    return;
  }
  const entry = await resolveMcpEntry(root);
  if (!entry) {
    void vscode.window.showErrorMessage(INSTALL_HINT);
    return;
  }
  const file = path.join(root, '.vscode', 'mcp.json');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let existing: { servers?: Record<string, unknown> } = {};
    if (fs.existsSync(file)) existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    existing.servers ??= {};
    existing.servers['gatetest'] = { type: 'stdio', ...entry };
    fs.writeFileSync(file, JSON.stringify(existing, null, 2) + '\n');
    void vscode.window.showInformationMessage(`GateTest MCP server added to ${path.relative(root, file)}.`);
  } catch (err) {
    void vscode.window.showErrorMessage(`Could not write ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const IDE_PICKS: Record<string, string> = {
  'VS Code (this workspace)': 'vscode',
  'Claude Code': 'claude',
  'Cursor': 'cursor',
  'Windsurf': 'windsurf',
  'Cline': 'cline',
  'Zed': 'zed',
};

async function setupMcpServer() {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const entry = await resolveMcpEntry(root);
  if (!entry) {
    void vscode.window.showErrorMessage(INSTALL_HINT);
    return;
  }

  const pick = await vscode.window.showQuickPick(
    [...Object.keys(IDE_PICKS), 'All of the above'],
    { canPickMany: false, placeHolder: 'Which AI tools should get the GateTest MCP server?' }
  );
  if (!pick) return;

  const targets = pick === 'All of the above' ? Object.values(IDE_PICKS) : [IDE_PICKS[pick]];
  const results: string[] = [];
  for (const target of targets) {
    if (target === 'vscode') {
      await addWorkspaceMcp();
      results.push('vscode');
      continue;
    }
    const ok = writeIdeMcpConfig(target, entry);
    results.push(ok ? target : `${target} (could not write its config)`);
  }

  void vscode.window.showInformationMessage(
    `GateTest MCP configured for: ${results.join(', ')}. Restart the tool to apply.`
  );
}

function writeIdeMcpConfig(ide: string, entry: unknown): boolean {
  const home = os.homedir();
  const configPaths: Record<string, string[]> = {
    claude:   [path.join(home, '.claude.json')],
    cursor:   [
      path.join(home, '.cursor', 'mcp.json'),
      path.join(home, '.config', 'Cursor', 'User', 'mcp.json'),
    ],
    windsurf: [path.join(home, '.codeium', 'windsurf', 'mcp_config.json')],
    cline:    [path.join(home, '.cline', 'mcp_servers.json')],
    zed:      [path.join(home, '.config', 'zed', 'settings.json')],
  };

  const targets = configPaths[ide];
  if (!targets) return false;

  for (const configPath of targets) {
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      let existing: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      }
      // Zed keys its servers differently; the others use mcpServers at the root.
      const key = ide === 'zed' ? 'context_servers' : 'mcpServers';
      existing[key] ??= {};
      (existing[key] as Record<string, unknown>)['gatetest'] = entry;
      fs.writeFileSync(configPath, JSON.stringify(existing, null, 2));
      return true;
    } catch (err) {
      outputChannel.appendLine(`[GateTest] Could not write ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
  }
  return false;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setStatus(state: 'idle' | 'scanning' | 'passed' | 'failed' | 'error', count?: number) {
  const icons = { idle: '$(shield)', scanning: '$(sync~spin)', passed: '$(pass)', failed: '$(error)', error: '$(warning)' };
  const labels = {
    idle: 'GateTest',
    scanning: 'GateTest: Scanning…',
    passed: count ? `GateTest: Passed (${count} note${count === 1 ? '' : 's'})` : 'GateTest: Passed',
    failed: `GateTest: ${count ?? 0} issue${count === 1 ? '' : 's'}`,
    error: 'GateTest: Error',
  };
  statusBarItem.text = `${icons[state]} ${labels[state]}`;
  statusBarItem.backgroundColor =
    state === 'failed' ? new vscode.ThemeColor('statusBarItem.errorBackground') :
    state === 'error' ? new vscode.ThemeColor('statusBarItem.warningBackground') :
    undefined;
}

/** With a shell, Node joins args with spaces and quotes nothing — so quote here. */
function shellQuote(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function runProcess(launch: CliLaunch, args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const all = [...launch.args, ...args];
    const proc = launch.shell
      ? cp.spawn(shellQuote(launch.command), all.map(shellQuote), { cwd, env: launch.env, shell: true, windowsHide: true })
      : cp.spawn(launch.command, all, { cwd, env: launch.env, windowsHide: true });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { err += d.toString(); outputChannel.append(d.toString()); });
    proc.on('error', (e: NodeJS.ErrnoException) => {
      reject(new Error(`could not start ${launch.description}: ${e.code || ''} ${e.message}`.trim()));
    });
    // Exit code is data, not an error: 1 is "the gate blocked" and the
    // document on stdout says so. 2 is a usage error, also on stderr.
    proc.on('close', (code) => resolve({ code, stdout: out, stderr: err }));
  });
}

function openFixDashboard() {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const repoName = root ? path.basename(root) : 'your-repo';
  void vscode.env.openExternal(
    vscode.Uri.parse(`https://gatetest.io?repo=${encodeURIComponent(repoName)}`)
  );
}

function openDashboard() {
  void vscode.env.openExternal(vscode.Uri.parse('https://gatetest.io'));
}

function showPanel() {
  void vscode.commands.executeCommand('workbench.panel.markers.view.focus');
}
