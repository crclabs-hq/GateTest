/**
 * GateTest VS Code Extension
 *
 * Native VS Code / Cursor / Windsurf integration.
 * - Runs the GateTest engine IN-PROCESS (a worker thread inside the extension
 *   host) and shows findings as inline diagnostics — no CLI on PATH, no
 *   child process, no JSON-over-stdout.
 * - Fixes one finding locally on the user's own AI provider key, with the
 *   cost shown before and after, a diff preview, and a re-scan to verify.
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

interface FixCost {
  tokensIn: number;
  tokensOut: number;
  usdEstimated: number | null;
  depth: string;
  model: string;
  calls: number;
  priced: boolean;
  priceNote: string | null;
  knownPrice: boolean | null;
  exact: boolean;
  capUsd: number | null;
  capEnforced: boolean;
  aborted: boolean;
  abortReason: string | null;
}

interface FixOutcome {
  fixed: boolean;
  reason: string | null;
  proposed: string | null;
  changed: boolean;
  hypothesis: string | null;
  rank: number | null;
  attempt: number | null;
  lineDelta: number | null;
  advisory: string | null;
  playback: boolean;
  testsRun: boolean;
  testsNote?: string;
  cost: FixCost;
}

interface FixEstimateResult {
  available: boolean;
  reason?: string;
  estimate?: { perAttemptUsd: number; worstCaseUsd: number; maxAttempts: number; knownPrice: boolean };
}

interface EstimateMessage {
  type: 'estimate';
  estimate: FixEstimateResult;
  depth: string;
  model: string;
  maxUsd: number | null;
  engineVersion: string;
  priced: boolean;
  priceNote: string | null;
}

interface EngineBridge {
  EDITOR_SKIP_MODULES: string[];
  PROVIDER_KEY_STORAGE_ID: string;
  resolveEngineEntry(input: { configuredPath?: string; workspaceRoot?: string; extensionDir?: string }): {
    entry: string | null;
    version: string | null;
    source: string | null;
    packageDir?: string;
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
  resolveFixDepth(packageDir: string | undefined, raw: string): { ok: boolean; depth: string | null; model: string | null; error?: string };
  issueTextFor(record: DiagnosticRecord): string;
  formatUsd(n: number | null): string;
  formatCost(cost: FixCost): string;
  formatEstimate(result: FixEstimateResult, maxUsd: number): string;
  capDecision(input: { usd: number | null; maxUsd: number; priced: boolean }): {
    allowed: boolean; enforced: boolean; needsConfirmation?: boolean; reason: string;
  };
  findingStillPresent(records: DiagnosticRecord[], target: DiagnosticRecord): boolean;
}

type WorkerMessage =
  | { type: 'progress'; event: string; payload?: { module?: string; status?: string; duration?: number; count?: number; call?: number; tokensIn?: number; tokensOut?: number; usdEstimated?: number | null } }
  | { type: 'log'; level: string; text: string }
  | { type: 'done'; summary?: EngineSummary; fix?: FixOutcome }
  | { type: 'error'; message: string; stack?: string }
  | EstimateMessage;

// ─── Extension state ─────────────────────────────────────────────────────────

let diagnosticCollection: vscode.DiagnosticCollection;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let extensionDir = '';
let bridge: EngineBridge;
let activeWorker: Worker | null = null;
let extensionContext: vscode.ExtensionContext;
/** The findings behind the current diagnostics, and the suite that produced them. */
let lastRecords: DiagnosticRecord[] = [];
let lastScanSuite = 'quick';

/** Proposed fixes for the diff preview live in memory, never on disk. */
const FIX_PREVIEW_SCHEME = 'gatetest-fix';
const fixPreviews = new Map<string, string>();
const fixPreviewProvider: vscode.TextDocumentContentProvider = {
  provideTextDocumentContent(uri) {
    return fixPreviews.get(uri.toString()) ?? '';
  },
};

// ─── Activate ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
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
    vscode.workspace.registerTextDocumentContentProvider(FIX_PREVIEW_SCHEME, fixPreviewProvider),
    vscode.commands.registerCommand('gatetest.scanWorkspace', () => runScan('quick')),
    vscode.commands.registerCommand('gatetest.scanFull', () => runScan('full')),
    vscode.commands.registerCommand('gatetest.scanFile', scanCurrentFile),
    vscode.commands.registerCommand('gatetest.cancelScan', cancelScan),
    vscode.commands.registerCommand('gatetest.fixIssues', openFixDashboard),
    vscode.commands.registerCommand('gatetest.fixFindingLocal', fixFindingLocal),
    vscode.commands.registerCommand('gatetest.setProviderKey', setProviderKey),
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

function reportEngineMissing(engine: ReturnType<typeof resolveEngine>) {
  const tried = (engine.attempts || []).map((a) => `  ${a.source}: ${a.path}`).join('\n');
  outputChannel.appendLine(`[GateTest] engine not found. Tried:\n${tried}`);
  void vscode.window.showErrorMessage(
    'GateTest engine not found. Set "gatetest.enginePath" to a GateTest checkout or an installed @gatetest/cli, or reinstall the extension.',
    'Open Settings'
  ).then((choice) => {
    if (choice === 'Open Settings') void vscode.commands.executeCommand('workbench.action.openSettings', 'gatetest.enginePath');
  });
}

// ─── MCP server registration (on request only) ───────────────────────────────

// The MCP server ships as its own npm package; every client can run it through
// npx with no global install and no path to a binary. Nothing here runs at
// activation — both commands are explicit user actions.
const MCP_ENTRY = {
  command: 'npx',
  args: ['-y', '@gatetest/mcp-server'],
};

/** Write `.vscode/mcp.json` in the workspace — the file VS Code reads MCP servers from. */
async function addWorkspaceMcp() {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    void vscode.window.showErrorMessage('Open a workspace folder first.');
    return;
  }
  const file = path.join(root, '.vscode', 'mcp.json');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let existing: { servers?: Record<string, unknown> } = {};
    if (fs.existsSync(file)) existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    existing.servers ??= {};
    existing.servers['gatetest'] = { type: 'stdio', ...MCP_ENTRY };
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
  const picks = await vscode.window.showQuickPick(
    [...Object.keys(IDE_PICKS), 'All of the above'],
    { canPickMany: false, placeHolder: 'Which AI tools do you use?' }
  );
  if (!picks) return;

  const targets = picks === 'All of the above' ? Object.values(IDE_PICKS) : [IDE_PICKS[picks]];

  const results: string[] = [];
  for (const target of targets) {
    if (target === 'vscode') {
      await addWorkspaceMcp();
      results.push('✓ vscode (.vscode/mcp.json)');
      continue;
    }
    const ok = writeIdeMcpConfig(target, MCP_ENTRY);
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

/** Runs a scan, applies diagnostics, and returns the summary (null when nothing ran). */
async function runScan(suite: string, targetFile?: string): Promise<{ summary: EngineSummary; inFiles: DiagnosticRecord[] } | null> {
  if (activeWorker) {
    void vscode.window.showWarningMessage('A GateTest scan is already running.', 'Cancel it').then((choice) => {
      if (choice === 'Cancel it') cancelScan();
    });
    return null;
  }

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    void vscode.window.showErrorMessage('Open a workspace folder first.');
    return null;
  }

  const engine = resolveEngine();
  if (!engine.entry) {
    reportEngineMissing(engine);
    return null;
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
    lastScanSuite = suite;
    const verdict = bridge.summarize(summary, { onlyFile: targetFile, inFilesCount: inFiles.length });

    outputChannel.appendLine(`[GateTest] ${verdict.text} · ${Math.round(summary.duration / 1000)}s`);
    for (const r of repoLevel) {
      outputChannel.appendLine(`  [${r.severity}] ${r.module}: ${r.message}`);
    }

    setStatus(verdict.passed ? 'passed' : 'failed', inFiles.length);
    if (!verdict.passed) {
      void vscode.window.showWarningMessage(
        `GateTest: ${verdict.errors} blocking finding(s). Check the Problems panel.`,
        'Fix with AI', 'Fix one locally (your key)'
      ).then((choice) => {
        if (choice === 'Fix with AI') void openFixDashboard();
        if (choice === 'Fix one locally (your key)') void fixFindingLocal();
      });
    } else if (summary.nothingChecked) {
      void vscode.window.showWarningMessage('GateTest: nothing was checked — no source files found under the workspace root.');
    } else {
      void vscode.window.showInformationMessage('GateTest: All checks passed ✓');
    }
    return { summary, inFiles };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'cancelled') {
      setStatus('idle');
      outputChannel.appendLine('[GateTest] scan cancelled');
    } else {
      setStatus('error');
      outputChannel.appendLine(`[GateTest] Scan error: ${message}`);
    }
    return null;
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
          if (msg.summary) finish(() => resolve(msg.summary as EngineSummary));
          else finish(() => reject(new Error('engine worker finished without a scan summary')));
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
  lastRecords = records;
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

// ─── Local fix on the user's own key ─────────────────────────────────────────

/** Store or clear the provider key. SecretStorage only — never settings.json. */
async function setProviderKey() {
  const secrets = extensionContext.secrets;
  const existing = await secrets.get(bridge.PROVIDER_KEY_STORAGE_ID);
  const value = await vscode.window.showInputBox({
    title: 'GateTest: AI provider key for local fixes',
    prompt: existing
      ? 'A key is stored. Paste a new key to replace it, or leave this empty and press Enter to clear it.'
      : 'Paste the API key from your AI provider — the same key `gatetest fix` reads from ANTHROPIC_API_KEY. It is kept in VS Code secret storage, never in settings.json. Fixes run on your account; you pay your provider directly.',
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) return; // dismissed
  if (!value.trim()) {
    if (existing) {
      await secrets.delete(bridge.PROVIDER_KEY_STORAGE_ID);
      void vscode.window.showInformationMessage('GateTest: AI provider key cleared.');
    } else {
      void vscode.window.showInformationMessage('GateTest: no AI provider key is stored.');
    }
    return;
  }
  await secrets.store(bridge.PROVIDER_KEY_STORAGE_ID, value.trim());
  void vscode.window.showInformationMessage('GateTest: AI provider key stored in secret storage. "Fix This Finding (your own key)" is ready.');
}

/** The finding under the cursor, or a QuickPick over the current findings. */
async function pickFinding(): Promise<DiagnosticRecord | undefined> {
  const candidates = lastRecords.filter((r) => r.file);
  if (candidates.length === 0) {
    void vscode.window.showWarningMessage('GateTest: no findings to fix — run a scan first.');
    return undefined;
  }
  const editor = vscode.window.activeTextEditor;
  const currentFile = editor ? path.resolve(editor.document.uri.fsPath) : null;
  if (editor && currentFile) {
    const line = editor.selection.active.line + 1;
    const atCursor = candidates.filter((r) => path.resolve(r.file as string) === currentFile && r.line === line);
    if (atCursor.length === 1) return atCursor[0];
  }
  const items = candidates
    .slice()
    .sort((a, b) => {
      const aCur = currentFile && path.resolve(a.file as string) === currentFile ? 0 : 1;
      const bCur = currentFile && path.resolve(b.file as string) === currentFile ? 0 : 1;
      return aCur - bCur || (a.file as string).localeCompare(b.file as string) || a.line - b.line;
    })
    .map((r) => ({
      label: `$(${r.severity === 'error' ? 'error' : r.severity === 'warning' ? 'warning' : 'info'}) ${path.basename(r.file as string)}:${r.line}`,
      description: `${r.module}${r.rule ? ` · ${r.rule}` : ''}`,
      detail: r.message,
      record: r,
    }));
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Which finding should be fixed on your own key?',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return pick?.record;
}

async function fixFindingLocal() {
  if (activeWorker) {
    void vscode.window.showWarningMessage('GateTest is busy — wait for the current scan or fix to finish, or cancel it.');
    return;
  }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    void vscode.window.showErrorMessage('Open a workspace folder first.');
    return;
  }
  const engine = resolveEngine();
  if (!engine.entry) {
    reportEngineMissing(engine);
    return;
  }

  const apiKey = await extensionContext.secrets.get(bridge.PROVIDER_KEY_STORAGE_ID);
  if (!apiKey) {
    const choice = await vscode.window.showWarningMessage(
      'GateTest: no AI provider key is stored. Local fixes run on your own key and your own account — get one from your AI provider (the same key the CLI reads from ANTHROPIC_API_KEY), then store it with "GateTest: Set AI Provider Key". Or use the hosted fix, which needs no key.',
      'Set key', 'Use hosted fix'
    );
    if (choice === 'Set key') await setProviderKey();
    if (choice === 'Use hosted fix') openFixDashboard();
    return;
  }

  const target = await pickFinding();
  if (!target || !target.file) return;

  const cfg = vscode.workspace.getConfiguration('gatetest');
  const depthSetting = cfg.get<string>('fixDepth', 'standard');
  const maxUsd = Number(cfg.get<number>('fixMaxUsd', 2));
  const depthChoice = bridge.resolveFixDepth(engine.packageDir, depthSetting);
  if (!depthChoice.ok || !depthChoice.depth) {
    void vscode.window.showErrorMessage(`GateTest: ${depthChoice.error}`, 'Open Settings').then((c) => {
      if (c === 'Open Settings') void vscode.commands.executeCommand('workbench.action.openSettings', 'gatetest.fixDepth');
    });
    return;
  }
  const depth = depthChoice.depth;
  const issue = bridge.issueTextFor(target);
  const fileLabel = path.relative(root, target.file);

  outputChannel.show(true);
  outputChannel.appendLine(`[GateTest fix] ${fileLabel}:${target.line} — ${issue}`);
  outputChannel.appendLine(`[GateTest fix] engine ${engine.version} (${engine.source}) · depth ${depth} · cap ${maxUsd > 0 ? bridge.formatUsd(maxUsd) : 'none'} · your own key`);
  setStatus('scanning');

  let outcome: FixOutcome;
  try {
    outcome = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `GateTest: fixing ${path.basename(target.file)} on your key`, cancellable: true },
      (progress, token) => runFixInWorker({
        mode: 'fix',
        entry: engine.entry as string,
        file: target.file as string,
        issues: [issue],
        apiKey,
        depth,
        maxUsd,
      }, progress, token, (estimateMsg) => confirmEstimate(estimateMsg, maxUsd))
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus('idle');
    outputChannel.appendLine(message === 'cancelled' ? '[GateTest fix] cancelled' : `[GateTest fix] error: ${message}`);
    if (message !== 'cancelled') void vscode.window.showErrorMessage(`GateTest fix failed: ${message}`);
    return;
  }
  setStatus(lastRecords.length ? 'failed' : 'idle', lastRecords.length);

  // AFTER: the actual spend, whatever happened.
  const costLine = bridge.formatCost(outcome.cost);
  outputChannel.appendLine(`[GateTest fix] cost (actual): ${costLine}`);
  if (outcome.cost.aborted) {
    outputChannel.appendLine(`[GateTest fix] cap: ${outcome.cost.abortReason} — the run stopped before the next call (one in-flight call can overshoot the cap)`);
  }
  if (outcome.reason === 'declined') {
    outputChannel.appendLine('[GateTest fix] not run — declined at the estimate');
    return;
  }
  if (!outcome.fixed || !outcome.proposed) {
    outputChannel.appendLine(`[GateTest fix] no fix produced: ${outcome.reason || 'unknown reason'}`);
    void vscode.window.showWarningMessage(`GateTest: no fix produced (${outcome.reason || 'unknown reason'}). Cost: ${costLine}`);
    return;
  }
  if (!outcome.changed) {
    outputChannel.appendLine('[GateTest fix] the proposal is identical to the file — nothing to apply');
    void vscode.window.showInformationMessage(`GateTest: the engine proposed no change. Cost: ${costLine}`);
    return;
  }
  if (outcome.testsNote) outputChannel.appendLine(`[GateTest fix] ${outcome.testsNote}`);
  if (outcome.advisory) outputChannel.appendLine(`[GateTest fix] advisory: ${outcome.advisory}`);

  await previewAndApply(target, outcome, issue, fileLabel, costLine);
}

/** BEFORE: show the estimate and the cap decision; nothing is sent until this returns true. */
async function confirmEstimate(msg: EstimateMessage, maxUsd: number): Promise<boolean> {
  const text = bridge.formatEstimate(msg.estimate, maxUsd);
  outputChannel.appendLine(`[GateTest fix] cost (estimate): ${text}`);
  const decision = msg.estimate.available && msg.estimate.estimate
    ? bridge.capDecision({ usd: msg.estimate.estimate.perAttemptUsd, maxUsd, priced: true })
    : bridge.capDecision({ usd: null, maxUsd, priced: false });
  outputChannel.appendLine(`[GateTest fix] cap: ${decision.reason}`);
  if (!decision.allowed) {
    void vscode.window.showErrorMessage(`GateTest: fix not started — ${decision.reason}. Raise gatetest.fixMaxUsd or pick a cheaper model.`);
    return false;
  }
  const choice = await vscode.window.showWarningMessage(
    `Run the fix at "${msg.depth}" depth with your own key?\n\n${text}\n\n${decision.reason}. You pay your provider directly; the actual tokens and cost are reported when the run ends.`,
    { modal: true },
    'Run fix'
  );
  return choice === 'Run fix';
}

/** Diff preview → Apply (write + save) → re-scan → verified / still present / not checked. */
async function previewAndApply(target: DiagnosticRecord, outcome: FixOutcome, issue: string, fileLabel: string, costLine: string) {
  const file = target.file as string;
  const originalUri = vscode.Uri.file(file);
  const proposedUri = vscode.Uri.from({ scheme: FIX_PREVIEW_SCHEME, path: file, query: String(Date.now()) });
  fixPreviews.set(proposedUri.toString(), outcome.proposed as string);
  try {
    await vscode.commands.executeCommand('vscode.diff', originalUri, proposedUri, `GateTest fix: ${path.basename(file)} (current ↔ proposed)`);
    const choice = await vscode.window.showInformationMessage(
      `GateTest proposed a fix for ${fileLabel} (${outcome.hypothesis || 'hypothesis'}, ${outcome.lineDelta ?? '?'} line(s) delta). Cost: ${costLine}\n\nApply writes the file and re-scans it to verify the finding is gone. Nothing has been written yet.`,
      { modal: true },
      'Apply', 'Discard'
    );
    if (choice !== 'Apply') {
      outputChannel.appendLine('[GateTest fix] discarded — the file was not changed');
      return;
    }

    const doc = await vscode.workspace.openTextDocument(originalUri);
    const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    const edit = new vscode.WorkspaceEdit();
    edit.replace(originalUri, fullRange, outcome.proposed as string);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied || !(await doc.save())) {
      outputChannel.appendLine('[GateTest fix] apply failed — the editor rejected the edit or the save');
      void vscode.window.showErrorMessage(`GateTest: could not apply the fix to ${fileLabel}.`);
      return;
    }
    outputChannel.appendLine(`[GateTest fix] applied and saved ${fileLabel} — re-scanning (${lastScanSuite}) to verify`);
  } finally {
    fixPreviews.delete(proposedUri.toString());
  }

  const rescan = await runScan(lastScanSuite, file);
  if (!rescan) {
    outputChannel.appendLine('[GateTest fix] NOT VERIFIED — the re-scan did not run');
    void vscode.window.showWarningMessage(`GateTest: fix applied to ${fileLabel} but the re-scan did not run — not verified. Cost: ${costLine}`);
    return;
  }
  const ranModules = new Set(rescan.summary.results.map((r) => r.module));
  if (!ranModules.has(target.module)) {
    outputChannel.appendLine(`[GateTest fix] NOT CHECKED — module ${target.module} did not run in the ${lastScanSuite} re-scan`);
    void vscode.window.showWarningMessage(`GateTest: fix applied, but module ${target.module} did not run in the re-scan — not verified. Cost: ${costLine}`);
    return;
  }
  if (bridge.findingStillPresent(rescan.inFiles, target)) {
    outputChannel.appendLine(`[GateTest fix] STILL PRESENT after re-scan — ${issue}`);
    void vscode.window.showWarningMessage(`GateTest: fix applied, but the finding is still present after the re-scan (${target.module}${target.rule ? ` · ${target.rule}` : ''}). Cost: ${costLine}`);
    return;
  }
  outputChannel.appendLine(`[GateTest fix] VERIFIED — ${issue} is gone after re-scan`);
  void vscode.window.showInformationMessage(`GateTest: fix verified — the finding is gone after the re-scan. Cost: ${costLine}`);
}

function runFixInWorker(
  data: { mode: 'fix'; entry: string; file: string; issues: string[]; apiKey: string; depth: string; maxUsd: number },
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
  onEstimate: (msg: EstimateMessage) => Promise<boolean>,
): Promise<FixOutcome> {
  return new Promise<FixOutcome>((resolve, reject) => {
    const worker = new Worker(path.join(extensionDir, 'engine', 'engine-worker.js'), { workerData: data });
    activeWorker = worker;
    let settled = false;

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

    progress.report({ message: 'estimating cost…' });
    worker.on('message', (msg: WorkerMessage) => {
      switch (msg.type) {
        case 'estimate':
          void onEstimate(msg).then(
            (ok) => {
              if (settled) return;
              progress.report({ message: ok ? 'calling your provider…' : 'declined' });
              worker.postMessage({ type: 'proceed', ok });
            },
            (err) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))),
          );
          break;
        case 'progress':
          if (msg.event === 'fix:call') progress.report({ message: `provider call ${msg.payload?.call ?? ''}…` });
          if (msg.event === 'fix:usage') {
            const usd = msg.payload?.usdEstimated;
            const spend = typeof usd === 'number' ? bridge.formatUsd(usd) : 'USD n/a';
            progress.report({ message: `${msg.payload?.tokensIn ?? 0} in / ${msg.payload?.tokensOut ?? 0} out tokens · ${spend} so far` });
            outputChannel.appendLine(`  call ${msg.payload?.call}: ${msg.payload?.tokensIn} in / ${msg.payload?.tokensOut} out tokens · ${spend} so far`);
          }
          break;
        case 'log':
          if (msg.level === 'warn' || msg.level === 'error') outputChannel.appendLine(`  [${msg.level}] ${msg.text}`);
          break;
        case 'done':
          if (msg.fix) finish(() => resolve(msg.fix as FixOutcome));
          else finish(() => reject(new Error('engine worker finished without a fix result')));
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setStatus(state: 'idle' | 'scanning' | 'passed' | 'failed' | 'error', count?: number) {
  const icons = { idle: '$(shield)', scanning: '$(sync~spin)', passed: '$(pass)', failed: '$(error)', error: '$(warning)' };
  const labels = {
    idle: 'GateTest',
    scanning: 'GateTest: Working…',
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
