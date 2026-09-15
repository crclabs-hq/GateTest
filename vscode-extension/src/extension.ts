/**
 * GateTest VS Code Extension
 *
 * Native VS Code / Cursor / Windsurf integration.
 * - Runs the GateTest engine IN-PROCESS (a worker thread inside the extension
 *   host) and shows findings as inline diagnostics — no CLI on PATH, no
 *   child process, no JSON-over-stdout.
 * - Sidebar panel for issues, status bar showing scan state
 * - One command to configure the MCP server for AI coding tools
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
  };

  const picks = await vscode.window.showQuickPick(
    ['Claude Code', 'Cursor', 'Windsurf', 'Cline', 'Zed', 'All of the above'],
    { canPickMany: false, placeHolder: 'Which AI tools do you use?' }
  );
  if (!picks) return;

  const targets = picks === 'All of the above'
    ? ['claude', 'cursor', 'windsurf', 'cline', 'zed']
    : [picks.toLowerCase().replace(' code', '').replace(' ', '')];

  const results: string[] = [];
  for (const target of targets) {
    const ok = writeIdeMcpConfig(target, mcpEntry);
    results.push(ok ? `✓ ${target}` : `✗ ${target} (could not detect config path)`);
  }

  void vscode.window.showInformationMessage(
    `GateTest MCP configured:\n${results.join(', ')}\nRestart your AI tool to apply.`
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

      // Each IDE uses a slightly different schema
      if (ide === 'zed') {
        (existing as Record<string, unknown>)['context_servers'] ??= {};
        ((existing as Record<string, unknown>)['context_servers'] as Record<string, unknown>)['gatetest'] = entry;
      } else {
        // claude, cursor, windsurf, cline all use mcpServers at root
        (existing as Record<string, unknown>)['mcpServers'] ??= {};
        ((existing as Record<string, unknown>)['mcpServers'] as Record<string, unknown>)['gatetest'] = entry;
      }

      fs.writeFileSync(configPath, JSON.stringify(existing, null, 2));
      return true;
    } catch {
      continue;
    }
  }
  return false;
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
        'Fix with AI'
      ).then((choice) => {
        if (choice === 'Fix with AI') void openFixDashboard();
      });
    } else if (summary.nothingChecked) {
      void vscode.window.showWarningMessage('GateTest: nothing was checked — no source files found under the workspace root.');
    } else {
      void vscode.window.showInformationMessage('GateTest: All checks passed ✓');
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

  for (const rec of records) {
    if (!rec.file) continue;
    const uri = vscode.Uri.file(rec.file);
    const key = uri.toString();

    const line = Math.max(0, rec.line - 1);
    const range = new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);

    const severity =
      rec.severity === 'error' ? vscode.DiagnosticSeverity.Error :
      rec.severity === 'warning' ? vscode.DiagnosticSeverity.Warning :
      vscode.DiagnosticSeverity.Information;

    const text = rec.suggestion ? `${rec.message}\nFix: ${rec.suggestion}` : rec.message;
    const diag = new vscode.Diagnostic(range, text, severity);
    diag.source = `GateTest [${rec.module}]`;
    if (rec.rule) diag.code = rec.rule;

    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key)!.push(diag);
  }

  for (const [uriStr, diags] of byFile) {
    diagnosticCollection.set(vscode.Uri.parse(uriStr), diags);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setStatus(state: 'idle' | 'scanning' | 'passed' | 'failed' | 'error', count?: number) {
  const icons = { idle: '$(shield)', scanning: '$(sync~spin)', passed: '$(pass)', failed: '$(error)', error: '$(warning)' };
  const labels = {
    idle: 'GateTest',
    scanning: 'GateTest: Scanning…',
    passed: 'GateTest: Passed',
    failed: `GateTest: ${count} issues`,
    error: 'GateTest: Error',
  };
  statusBarItem.text = `${icons[state]} ${labels[state]}`;
  statusBarItem.backgroundColor =
    state === 'failed' ? new vscode.ThemeColor('statusBarItem.errorBackground') :
    state === 'error' ? new vscode.ThemeColor('statusBarItem.warningBackground') :
    undefined;
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
