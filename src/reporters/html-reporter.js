/**
 * HTML Reporter - GateTest Dashboard
 *
 * Generates a clean, readable dashboard that answers three questions:
 *   1. What did GateTest find?
 *   2. What has been fixed?
 *   3. What's still broken?
 *
 * Tracks scan history so you can see progress over time.
 */

const fs = require('fs');
const path = require('path');

class HtmlReporter {
  constructor(runner, config) {
    this.runner = runner;
    this.config = config;
    this._attach();
  }

  _attach() {
    this.runner.on('suite:end', (summary) => this._onSuiteEnd(summary));
  }

  _onSuiteEnd(summary) {
    const reportDir = this.config.get('reporting.outputDir') || '.gatetest/reports';
    const absDir = path.resolve(this.config.projectRoot, reportDir);

    if (!fs.existsSync(absDir)) {
      fs.mkdirSync(absDir, { recursive: true });
    }

    // Save this scan to history
    const historyPath = path.join(absDir, 'scan-history.json');
    let history = [];
    if (fs.existsSync(historyPath)) {
      try { history = JSON.parse(fs.readFileSync(historyPath, 'utf-8')); } catch {} // error-ok — malformed history treated as empty; fresh start
    }
    history.push({
      timestamp: summary.timestamp,
      gateStatus: summary.gateStatus,
      modulesTotal: summary.modules.total,
      modulesPassed: summary.modules.passed,
      checksTotal: summary.checks.total,
      checksPassed: summary.checks.passed,
      checksFailed: summary.checks.failed,
      duration: summary.duration,
    });
    // Keep last 50 scans
    if (history.length > 50) history = history.slice(-50);
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));

    const html = this._generateHtml(summary, history);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(absDir, `gatetest-report-${timestamp}.html`), html);
    fs.writeFileSync(path.join(absDir, 'gatetest-report-latest.html'), html);
  }

  _generateHtml(summary, history) {
    const passed = summary.gateStatus === 'PASSED';
    const totalIssues = summary.checks.failed;
    const totalPassed = summary.checks.passed;
    // Info-severity "findings" (markdown whitespace nits, missing Stylelint
    // config, etc.) never block and are never even a warning, but each one
    // still counts as one failed check — left in the denominator, the pass
    // rate shown to the customer reads worse than the scan actually is
    // (self-scan 2026-07-15: 1272/2506 = 51% on a healthy repo).
    const infoFindings = summary.checks.infoFindings || 0;
    const totalChecks = summary.checks.total - infoFindings;
    const passRate = totalChecks > 0 ? Math.round((totalPassed / totalChecks) * 100) : 0;

    // Categorize issues
    const categories = {
      security: { label: 'Security', icon: '🔒', items: [], color: '#ef4444' },
      syntax: { label: 'Syntax & Build', icon: '⚙️', items: [], color: '#f97316' },
      accessibility: { label: 'Accessibility', icon: '♿', items: [], color: '#8b5cf6' },
      quality: { label: 'Code Quality', icon: '📋', items: [], color: '#3b82f6' },
      visual: { label: 'Visual & UI', icon: '🎨', items: [], color: '#ec4899' },
      performance: { label: 'Performance', icon: '⚡', items: [], color: '#f59e0b' },
      testing: { label: 'Testing', icon: '🧪', items: [], color: '#10b981' },
      other: { label: 'Other', icon: '📦', items: [], color: '#64748b' },
    };

    const moduleToCategory = {
      secrets: 'security', security: 'security',
      syntax: 'syntax', lint: 'syntax',
      accessibility: 'accessibility',
      codeQuality: 'quality', documentation: 'quality',
      visual: 'visual',
      performance: 'performance',
      unitTests: 'testing', integrationTests: 'testing', e2e: 'testing',
      seo: 'other', links: 'other', compatibility: 'other', dataIntegrity: 'other',
    };

    for (const result of summary.results) {
      const cat = moduleToCategory[result.module] || 'other';
      const failedChecks = (result.checks || []).filter(c => !c.passed);
      for (const check of failedChecks) {
        categories[cat].items.push({
          module: result.module,
          name: check.name,
          file: check.file || '',
          line: check.line || '',
          suggestion: check.suggestion || '',
          expected: check.expected,
          actual: check.actual,
        });
      }
    }

    // Module summary
    const moduleRows = summary.results.map(r => {
      const icon = r.status === 'passed' ? '✓' : r.status === 'failed' ? '✗' : '—';
      const cls = r.status === 'passed' ? 'pass' : r.status === 'failed' ? 'fail' : 'skip';
      return `<tr class="${cls}">
        <td class="status-icon">${icon}</td>
        <td>${r.module}</td>
        <td>${r.passedChecks}/${r.totalChecks}</td>
        <td>${r.failedChecks}</td>
        <td>${r.duration}ms</td>
      </tr>`;
    }).join('');

    // Issue cards by category
    const categoryBlocks = Object.entries(categories)
      .filter(([, cat]) => cat.items.length > 0)
      .map(([key, cat]) => {
        const items = cat.items.map((item, i) => {
          const loc = item.file ? `<code>${item.file}${item.line ? ':' + item.line : ''}</code>` : '';
          const fix = item.suggestion ? `<div class="fix">Fix: ${item.suggestion}</div>` : '';
          return `<div class="issue" data-cat="${key}" data-idx="${i}">
            <label class="issue-row">
              <input type="checkbox" class="issue-check" />
              <div class="issue-text">
                <div class="issue-name">${item.name}</div>
                ${loc ? `<div class="issue-loc">${loc}</div>` : ''}
                ${fix}
              </div>
            </label>
          </div>`;
        }).join('');

        return `<div class="category">
          <div class="category-header" style="border-color:${cat.color}">
            <span class="category-icon">${cat.icon}</span>
            <span class="category-label">${cat.label}</span>
            <span class="category-count">${cat.items.length} issue${cat.items.length !== 1 ? 's' : ''}</span>
          </div>
          <div class="category-items">${items}</div>
        </div>`;
      }).join('');

    // Progress chart (last scans)
    const chartData = history.slice(-10).map(h => ({
      label: new Date(h.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      issues: h.checksFailed,
      passed: h.checksPassed,
    }));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GateTest Dashboard</title>
  <style>
    :root {
      --bg: #0b0f19; --surface: #111827; --border: #1e293b;
      --text: #e2e8f0; --muted: #64748b; --accent: #6366f1;
      --green: #22c55e; --red: #ef4444; --yellow: #f59e0b;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); }

    /* Top bar */
    .topbar {
      display: flex; align-items: center; justify-content: space-between;
      padding: 1.25rem 2rem;
      background: ${passed ? '#052e16' : '#1a0505'};
      border-bottom: 3px solid ${passed ? 'var(--green)' : 'var(--red)'};
    }
    .topbar h1 { font-size: 1.25rem; font-weight: 700; }
    .topbar h1 span { color: var(--accent); }
    .badge {
      font-size: 0.9rem; font-weight: 800; padding: 0.4rem 1.25rem; border-radius: 6px;
      color: #fff; background: ${passed ? 'var(--green)' : 'var(--red)'};
      letter-spacing: 0.05em;
    }
    .topbar-time { font-size: 0.8rem; color: var(--muted); }

    .container { max-width: 1100px; margin: 0 auto; padding: 1.5rem 2rem 4rem; }

    /* Summary cards */
    .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 2rem; }
    .card {
      background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
      padding: 1.25rem; text-align: center;
    }
    .card-value { font-size: 2.25rem; font-weight: 800; line-height: 1; }
    .card-value.green { color: var(--green); }
    .card-value.red { color: var(--red); }
    .card-value.yellow { color: var(--yellow); }
    .card-label { font-size: 0.8rem; color: var(--muted); margin-top: 0.5rem; }

    /* Progress bar */
    .progress { margin-bottom: 2rem; }
    .progress-bar { height: 10px; background: var(--border); border-radius: 5px; overflow: hidden; }
    .progress-fill { height: 100%; border-radius: 5px; background: ${passRate >= 80 ? 'var(--green)' : passRate >= 40 ? 'var(--yellow)' : 'var(--red)'}; width: ${passRate}%; transition: width 0.6s ease; }
    .progress-labels { display: flex; justify-content: space-between; margin-top: 0.5rem; font-size: 0.8rem; color: var(--muted); }

    /* Scan history chart */
    .chart-section { margin-bottom: 2rem; }
    .section-title { font-size: 1rem; font-weight: 700; margin-bottom: 1rem; display: flex; align-items: center; gap: 0.5rem; }
    .chart { display: flex; align-items: flex-end; gap: 4px; height: 80px; padding: 0.5rem 0; }
    .chart-bar {
      flex: 1; min-width: 20px; border-radius: 3px 3px 0 0;
      position: relative; cursor: default;
    }
    .chart-bar .tooltip {
      display: none; position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%);
      background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
      padding: 0.4rem 0.6rem; font-size: 0.7rem; white-space: nowrap; z-index: 10;
    }
    .chart-bar:hover .tooltip { display: block; }
    .chart-labels { display: flex; gap: 4px; }
    .chart-labels span { flex: 1; text-align: center; font-size: 0.65rem; color: var(--muted); min-width: 20px; }

    /* Module table */
    .module-table { width: 100%; border-collapse: collapse; background: var(--surface); border-radius: 10px; overflow: hidden; border: 1px solid var(--border); margin-bottom: 2rem; }
    .module-table th { background: #0f172a; padding: 0.75rem 1rem; text-align: left; font-size: 0.8rem; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
    .module-table td { padding: 0.65rem 1rem; border-top: 1px solid var(--border); font-size: 0.9rem; }
    .module-table tr.pass .status-icon { color: var(--green); font-weight: 700; }
    .module-table tr.fail .status-icon { color: var(--red); font-weight: 700; }
    .module-table tr.skip .status-icon { color: var(--yellow); }

    /* Issue categories */
    .category { margin-bottom: 1.5rem; }
    .category-header {
      display: flex; align-items: center; gap: 0.6rem;
      padding: 0.65rem 1rem; background: var(--surface); border-radius: 8px;
      border-left: 4px solid; margin-bottom: 0.5rem; font-weight: 600;
    }
    .category-icon { font-size: 1.1rem; }
    .category-label { flex: 1; }
    .category-count { font-size: 0.8rem; color: var(--muted); font-weight: 400; }

    .issue {
      background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
      margin-bottom: 4px; transition: opacity 0.3s, background 0.2s;
    }
    .issue.fixed { opacity: 0.35; }
    .issue.fixed .issue-name { text-decoration: line-through; }
    .issue-row { display: flex; align-items: flex-start; gap: 0.75rem; padding: 0.7rem 1rem; cursor: pointer; }
    .issue-check { width: 18px; height: 18px; margin-top: 2px; accent-color: var(--green); flex-shrink: 0; cursor: pointer; }
    .issue-text { flex: 1; min-width: 0; }
    .issue-name { font-size: 0.85rem; word-break: break-word; }
    .issue-loc { font-size: 0.75rem; color: var(--muted); margin-top: 0.2rem; }
    .issue-loc code { background: #1e293b; padding: 0.1rem 0.4rem; border-radius: 3px; font-size: 0.75rem; }
    .fix { font-size: 0.75rem; color: #22d3ee; margin-top: 0.2rem; font-style: italic; }

    /* Filter bar */
    .filters { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
    .filter-btn {
      padding: 0.4rem 0.9rem; border-radius: 6px; border: 1px solid var(--border);
      background: var(--surface); color: var(--text); font-size: 0.8rem; cursor: pointer;
      transition: all 0.15s;
    }
    .filter-btn:hover, .filter-btn.active { background: var(--accent); border-color: var(--accent); color: #fff; }

    /* Sticky footer counter */
    .counter {
      position: fixed; bottom: 0; left: 0; right: 0;
      background: var(--surface); border-top: 1px solid var(--border);
      padding: 0.75rem 2rem; display: flex; justify-content: center; align-items: center; gap: 1rem;
      font-size: 0.9rem; z-index: 100;
    }
    .counter-bar { flex: 0 0 200px; height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; }
    .counter-fill { height: 100%; background: var(--green); border-radius: 3px; transition: width 0.3s; }
    .counter b { color: var(--green); }

    @media (max-width: 768px) {
      .summary { grid-template-columns: repeat(2, 1fr); }
      .container { padding: 1rem; }
    }
  </style>
</head>
<body>
  <div class="topbar">
    <div>
      <h1><span>Gate</span>Test</h1>
      <div class="topbar-time">${summary.timestamp} &middot; ${summary.duration}ms</div>
    </div>
    <div class="badge">${passed ? 'PASSED' : 'BLOCKED'}</div>
  </div>

  <div class="container">
    <!-- Summary -->
    <div class="summary">
      <div class="card">
        <div class="card-value ${passRate >= 80 ? 'green' : passRate >= 40 ? 'yellow' : 'red'}">${passRate}%</div>
        <div class="card-label">Pass Rate</div>
      </div>
      <div class="card">
        <div class="card-value red">${totalIssues}</div>
        <div class="card-label">Issues Found</div>
      </div>
      <div class="card">
        <div class="card-value green">${summary.modules.passed}/${summary.modules.total}</div>
        <div class="card-label">Modules Passed</div>
      </div>
      <div class="card">
        <div class="card-value" id="fixed-value" style="color:var(--green)">0</div>
        <div class="card-label">Fixed So Far</div>
      </div>
    </div>

    <!-- Progress -->
    <div class="progress">
      <div class="progress-bar"><div class="progress-fill"></div></div>
      <div class="progress-labels">
        <span>${totalPassed} checks passing</span>
        <span>${totalIssues} issues to fix</span>
      </div>
    </div>

    <!-- Scan History -->
    ${history.length > 1 ? `
    <div class="chart-section">
      <div class="section-title">Scan History (issues over time)</div>
      <div class="chart">
        ${chartData.map(d => {
          const maxIssues = Math.max(...chartData.map(x => x.issues), 1);
          const h = Math.max(Math.round((d.issues / maxIssues) * 70), 4);
          const color = d.issues === 0 ? 'var(--green)' : d.issues < 50 ? 'var(--yellow)' : 'var(--red)';
          return `<div class="chart-bar" style="height:${h}px;background:${color}">
            <div class="tooltip">${d.issues} issues at ${d.label}</div>
          </div>`;
        }).join('')}
      </div>
      <div class="chart-labels">${chartData.map(d => `<span>${d.label}</span>`).join('')}</div>
    </div>` : ''}

    <!-- Modules -->
    <div class="section-title">Modules</div>
    <table class="module-table">
      <thead><tr><th></th><th>Module</th><th>Passed</th><th>Issues</th><th>Time</th></tr></thead>
      <tbody>${moduleRows}</tbody>
    </table>

    <!-- Filters -->
    <div class="section-title">Issues Checklist</div>
    <div class="filters">
      <button class="filter-btn active" data-filter="all">All (${totalIssues})</button>
      <button class="filter-btn" data-filter="open">Open</button>
      <button class="filter-btn" data-filter="fixed">Fixed</button>
    </div>

    <!-- Issues by category -->
    ${categoryBlocks || '<div style="text-align:center;padding:3rem;color:var(--green);font-size:1.5rem;font-weight:700;">All Clear — No Issues Found</div>'}
  </div>

  <!-- Fixed counter -->
  <div class="counter">
    <span><b id="fixed-count">0</b> / ${totalIssues} fixed</span>
    <div class="counter-bar"><div class="counter-fill" id="counter-fill" style="width:0%"></div></div>
  </div>

  <script>
    // State management
    const STORAGE_KEY = 'gatetest-fixed-' + ${JSON.stringify(summary.timestamp)};
    const totalIssues = ${totalIssues};
    const checkboxes = document.querySelectorAll('.issue-check');
    const fixedCountEl = document.getElementById('fixed-count');
    const fixedValueEl = document.getElementById('fixed-value');
    const counterFill = document.getElementById('counter-fill');
    let fixedCount = 0;

    // Load saved state
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');

    checkboxes.forEach((cb, i) => {
      const issue = cb.closest('.issue');

      // Restore state
      if (saved[i]) {
        cb.checked = true;
        issue.classList.add('fixed');
        fixedCount++;
      }

      cb.addEventListener('change', () => {
        if (cb.checked) {
          issue.classList.add('fixed');
          fixedCount++;
        } else {
          issue.classList.remove('fixed');
          fixedCount--;
        }
        updateCounter();
        saveState();
      });
    });

    function updateCounter() {
      fixedCountEl.textContent = fixedCount;
      fixedValueEl.textContent = fixedCount;
      const pct = totalIssues > 0 ? Math.round((fixedCount / totalIssues) * 100) : 0;
      counterFill.style.width = pct + '%';
    }

    function saveState() {
      const state = {};
      checkboxes.forEach((c, j) => { if (c.checked) state[j] = true; });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }

    updateCounter();

    // Filters
    const filterBtns = document.querySelectorAll('.filter-btn');
    filterBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        filterBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const filter = btn.dataset.filter;
        document.querySelectorAll('.issue').forEach(issue => {
          const isFixed = issue.classList.contains('fixed');
          if (filter === 'all') issue.style.display = '';
          else if (filter === 'open') issue.style.display = isFixed ? 'none' : '';
          else if (filter === 'fixed') issue.style.display = isFixed ? '' : 'none';
        });
      });
    });
  </script>
</body>
</html>`;
  }
}

module.exports = { HtmlReporter };
