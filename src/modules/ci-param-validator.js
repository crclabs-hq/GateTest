/**
 * CI Parameter Validator — validates GitHub Actions `with:` inputs.
 *
 * When a workflow calls a reusable action with `uses:` + `with:`, the
 * called action declares its `inputs:` in its `action.yml`. This module:
 *
 *   1. Reads every .github/workflows/*.yml in the repo.
 *   2. For each `uses:` step that references a LOCAL action (./actions/foo
 *      or ./.github/actions/foo), reads the action's action.yml.
 *   3. Validates: required inputs provided, no unknown inputs passed.
 *
 * Also catches:
 *   - `workflow_call` reusable workflows: `with:` keys vs `inputs:` schema.
 *   - Missing `required: true` inputs on composite actions.
 *
 * External action validation (e.g., `actions/checkout@v4`) is skipped —
 * we don't fetch from GitHub at scan time.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { repoRelative } = require('../core/repo-path');
const BaseModule    = require('./base-module');
const { makeAutoFix } = require('../core/ai-fix-engine');

// ─── YAML line-by-line mini parser (no dependency) ────────────────────────

function parseYamlInputs(content) {
  const inputs = {};
  let inInputsSection  = false;
  let inOnSection      = false;
  let inWorkflowCall   = false;
  let currentInput     = null;
  let inputIndent      = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line   = rawLine.replace(/#.*$/, '');
    const trimmed = line.trimStart();
    const indent  = line.length - trimmed.length;

    if (/^inputs\s*:/.test(trimmed)) {
      inInputsSection = true; inOnSection = false; inputIndent = null; continue;
    }
    if (/^on\s*:/.test(trimmed)) {
      inOnSection = true; continue;
    }
    if (inOnSection && /workflow_call\s*:/.test(trimmed)) {
      inWorkflowCall = true; continue;
    }
    if (inWorkflowCall && /^inputs\s*:/.test(trimmed)) {
      inInputsSection = true; continue;
    }

    // Detect leaving inputs section (a top-level key at indent 0 or 2)
    if (inInputsSection && indent === 0 && trimmed && !trimmed.startsWith('#')) {
      inInputsSection = false; currentInput = null; inputIndent = null;
    }

    if (!inInputsSection) continue;

    // Detect input name (2-space indented key)
    const inputNameMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*:/);
    if (inputNameMatch) {
      if (inputIndent === null) inputIndent = indent;
      if (indent === inputIndent) {
        currentInput = inputNameMatch[1];
        inputs[currentInput] = { required: false, default: undefined };
        continue;
      }
    }

    if (!currentInput) continue;

    if (/required\s*:\s*true/.test(trimmed))  inputs[currentInput].required = true;
    if (/default\s*:/.test(trimmed))           inputs[currentInput].default  = trimmed.split(':')[1]?.trim();
  }

  return inputs;
}

function parseWorkflowSteps(content) {
  const steps = [];
  let currentStep  = null;
  let inWith       = false;
  let withIndent   = null;

  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line    = rawLine.replace(/#.*$/, '');
    const trimmed = line.trimStart();
    const indent  = line.length - trimmed.length;

    // New step detected
    if (/^-\s+/.test(trimmed)) {
      currentStep = { uses: null, with: {}, line: i + 1 };
      steps.push(currentStep);
      inWith = false; withIndent = null;
    }

    if (!currentStep) continue;

    const usesMatch = trimmed.match(/^uses\s*:\s*(.+)/);
    if (usesMatch) { currentStep.uses = usesMatch[1].trim(); continue; }

    if (/^with\s*:/.test(trimmed)) {
      inWith = true; withIndent = null; continue;
    }

    if (inWith) {
      if (withIndent === null && trimmed) withIndent = indent;
      if (trimmed && indent > 0 && (withIndent === null || indent >= withIndent)) {
        const kvMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)/);
        if (kvMatch) currentStep.with[kvMatch[1]] = kvMatch[2].trim();
      } else if (trimmed && indent < (withIndent || 999)) {
        inWith = false; withIndent = null;
      }
    }
  }

  return steps.filter(s => s.uses);
}

// ─── resolve local action path ────────────────────────────────────────────

function resolveLocalAction(projectRoot, uses) {
  // Local: ./actions/foo, ./.github/actions/foo
  if (!uses.startsWith('./') && !uses.startsWith('../')) return null;
  const candidates = [
    path.join(projectRoot, uses, 'action.yml'),
    path.join(projectRoot, uses, 'action.yaml'),
    path.join(projectRoot, uses + '.yml'),
    path.join(projectRoot, uses + '.yaml'),
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

// ─── module ────────────────────────────────────────────────────────────────

class CiParamValidator extends BaseModule {
  constructor() {
    super('ciParamValidator', 'CI Parameter Validator — validates GitHub Actions with: inputs against action schemas');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const workflowDir = path.join(projectRoot, '.github', 'workflows');

    if (!fs.existsSync(workflowDir)) {
      result.addCheck('ci-param-validator:no-workflows', true, {
        severity: 'info',
        message: 'No .github/workflows directory — CI param validation skipped',
      });
      return;
    }

    let workflowFiles;
    try {
      workflowFiles = fs.readdirSync(workflowDir)
        .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
        .map(f => path.join(workflowDir, f));
    } catch {
      workflowFiles = [];
    }

    if (workflowFiles.length === 0) {
      result.addCheck('ci-param-validator:no-workflow-files', true, {
        severity: 'info',
        message: 'No workflow files found',
      });
      return;
    }

    let issueCount = 0;

    for (const wf of workflowFiles) {
      const wfRel = repoRelative(projectRoot, wf);
      let wfContent;
      try { wfContent = fs.readFileSync(wf, 'utf-8'); } catch { continue; }

      const steps = parseWorkflowSteps(wfContent);

      for (const step of steps) {
        if (!step.uses) continue;

        // Only validate local actions
        const actionYml = resolveLocalAction(projectRoot, step.uses);
        if (!actionYml) continue;

        let actionContent;
        try { actionContent = fs.readFileSync(actionYml, 'utf-8'); } catch { continue; }

        const declaredInputs = parseYamlInputs(actionContent);
        const providedKeys   = Object.keys(step.with);
        const declaredKeys   = Object.keys(declaredInputs);

        // Required inputs not provided
        for (const [key, meta] of Object.entries(declaredInputs)) {
          if (meta.required && meta.default === undefined && !providedKeys.includes(key)) {
            issueCount++;
            result.addCheck(`ci-param-validator:missing-required:${wfRel}:${step.uses}:${key}`, false, {
              severity: 'error',
              message: `Required input \`${key}\` not provided for action \`${step.uses}\` in \`${wfRel}\``,
              file: wfRel,
              line: step.line,
              fix: `Add \`${key}: <value>\` to the \`with:\` block of the \`${step.uses}\` step.`,
              autoFix: makeAutoFix(wf, 'ci-param-validator:missing-required', `Required input "${key}" not provided for action ${step.uses}`, step.line, `Add "${key}: <value>" to the with: block`),
            });
          }
        }

        // Unknown inputs passed (typos)
        for (const key of providedKeys) {
          if (!declaredKeys.includes(key)) {
            issueCount++;
            const similar = declaredKeys.find(k => k.toLowerCase() === key.toLowerCase());
            const hint    = similar ? ` Did you mean \`${similar}\`?` : '';
            result.addCheck(`ci-param-validator:unknown-input:${wfRel}:${step.uses}:${key}`, false, {
              severity: 'warning',
              message: `Unknown input \`${key}\` passed to action \`${step.uses}\` in \`${wfRel}\`.${hint} Declared inputs: ${declaredKeys.join(', ')}`,
              file: wfRel,
              line: step.line,
              fix: `Remove \`${key}\` from the \`with:\` block or check the action's action.yml.${hint}`,
              autoFix: makeAutoFix(wf, 'ci-param-validator:unknown-input', `Unknown input "${key}" for action ${step.uses}`, step.line, similar ? `Rename "${key}" to "${similar}"` : `Remove "${key}" from the with: block`),
            });
          }
        }
      }
    }

    if (issueCount === 0) {
      result.addCheck('ci-param-validator:clean', true, {
        severity: 'info',
        message: `All local action \`with:\` inputs validated across ${workflowFiles.length} workflow file(s)`,
      });
    }
  }
}

module.exports = CiParamValidator;
