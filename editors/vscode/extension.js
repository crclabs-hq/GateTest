/**
 * GateTest VS Code extension — MVP.
 *
 * Runs the free local 'quick' suite (syntax, lint, secrets, codeQuality —
 * same tier the free GitHub App install runs, see docs/GITHUB-APP-SETUP.md
 * and website/app/github/setup/page.tsx) against the open workspace and
 * surfaces findings as native editor diagnostics (red/yellow squiggles,
 * Problems panel). No account, no payment — this is the always-free local
 * engine, same as `gatetest --suite quick` on the CLI.
 *
 * Deeper scans (all 120 modules, AI code review, auto-fix PRs) are a
 * separate purchase at gatetest.ai — this extension does not attempt to
 * replicate that; it's the free tier's IDE-native surface, matching what's
 * already true of the GitHub App.
 */

'use strict';

const vscode = require('vscode');
const path = require('path');
const { mapSummaryToDiagnostics } = require('./lib/map-findings');

const SEVERITY_MAP = {
  Error: vscode.DiagnosticSeverity.Error,
  Warning: vscode.DiagnosticSeverity.Warning,
  Information: vscode.DiagnosticSeverity.Information,
};

let diagnosticCollection;
let scanInFlight = false;
let rescanQueued = false;

function getGateTest() {
  // Lazily required — a workspace without gatetest installed shouldn't
  // crash the extension at activation time, only when a scan is attempted.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@gatetest/cli');
}

async function runScan(workspaceRoot, outputChannel) {
  if (scanInFlight) {
    rescanQueued = true;
    return;
  }
  scanInFlight = true;
  try {
    const { GateTest } = getGateTest();
    const engine = new GateTest(workspaceRoot, { silent: true }).init();
    const summary = await engine.runSuite('quick');
    const byFile = mapSummaryToDiagnostics(summary, workspaceRoot);

    diagnosticCollection.clear();
    for (const [absPath, entries] of byFile.entries()) {
      const uri = vscode.Uri.file(absPath);
      const diagnostics = entries.map((e) => {
        const range = new vscode.Range(e.line, 0, e.line, Number.MAX_SAFE_INTEGER);
        const diagnostic = new vscode.Diagnostic(
          range,
          e.message,
          SEVERITY_MAP[e.severity] ?? vscode.DiagnosticSeverity.Information
        );
        diagnostic.source = e.source;
        diagnostic.code = e.ruleName;
        return diagnostic;
      });
      diagnosticCollection.set(uri, diagnostics);
    }

    outputChannel.appendLine(
      `[gatetest] quick scan: ${summary.checks.errors} error(s), ${summary.checks.warnings} warning(s) — ${summary.gateStatus}`
    );
  } catch (err) {
    outputChannel.appendLine(`[gatetest] scan failed: ${err && err.message ? err.message : err}`);
    vscode.window.showErrorMessage(
      `GateTest scan failed: ${err && err.message ? err.message : 'unknown error'}. Is @gatetest/cli installed in this project (npm i -D @gatetest/cli)?`
    );
  } finally {
    scanInFlight = false;
    if (rescanQueued) {
      rescanQueued = false;
      runScan(workspaceRoot, outputChannel);
    }
  }
}

function activate(context) {
  diagnosticCollection = vscode.languages.createDiagnosticCollection('gatetest');
  context.subscriptions.push(diagnosticCollection);

  const outputChannel = vscode.window.createOutputChannel('GateTest');
  context.subscriptions.push(outputChannel);

  const workspaceRoot = () =>
    vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]
      ? vscode.workspace.workspaceFolders[0].uri.fsPath
      : undefined;

  const scanCommand = vscode.commands.registerCommand('gatetest.scanWorkspace', () => {
    const root = workspaceRoot();
    if (!root) {
      vscode.window.showWarningMessage('GateTest: open a folder to scan.');
      return;
    }
    runScan(root, outputChannel);
  });
  context.subscriptions.push(scanCommand);

  // Free quick suite is fast (~2-3s per the committed benchmark corpus) and
  // deterministic-only (no API cost), so scanning on every save is cheap —
  // same behavior the free GitHub App install gives on every push.
  const onSave = vscode.workspace.onDidSaveTextDocument(() => {
    const root = workspaceRoot();
    if (root) runScan(root, outputChannel);
  });
  context.subscriptions.push(onSave);

  const root = workspaceRoot();
  if (root) runScan(root, outputChannel);
}

function deactivate() {
  if (diagnosticCollection) diagnosticCollection.dispose();
}

module.exports = { activate, deactivate };
