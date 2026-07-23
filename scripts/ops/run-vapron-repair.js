'use strict';

const { DirectRepair } = require('../../src/core/direct-repair');

const SKIP_MODULES = ['aiHallucination', 'prSize', 'flakyTests'];

async function main() {
  const repair = new DirectRepair({
    cacheDir: '/root/.gatecode/pattern-cache',
    verbose:  true,
    dryRun:   false,
  });

  console.log('=== GateTest Direct Repair — Vapron ===\n');

  const report = await repair.repair(
    'git@github.com:ccantynz-alt/Vapron.git',
    null,
    { skipModules: SKIP_MODULES }
  );

  console.log('\n=== REPAIR COMPLETE ===');
  console.log(`Findings:   ${report.findings.length}`);
  console.log(`Fixes:      ${report.fixes.length}`);
  console.log(`Cache hits: ${report.cacheHits}`);
  console.log(`Claude calls: ${report.claudeCalls}`);
  console.log(`Committed:  ${report.committed}`);
  if (report.commitSha) console.log(`Commit SHA: ${report.commitSha}`);
  if (report.branch)    console.log(`Branch:     ${report.branch}`);
  if (report.error)     console.log(`Error:      ${report.error}`);

  console.log('\nFixes applied:');
  for (const fix of report.fixes) {
    console.log(`  [${fix.finding.module}] ${fix.finding.file || ''}: ${fix.finding.message || fix.summary || ''}`);
  }

  if (report.fixes.length === 0) {
    console.log('  (none — findings may need manual review or Claude calls)');
    console.log('\nUnfixed findings by module:');
    const byModule = {};
    for (const f of report.findings) {
      byModule[f.module] = (byModule[f.module] || 0) + 1;
    }
    for (const [mod, count] of Object.entries(byModule).sort((a,b) => b[1]-a[1])) {
      console.log(`  ${mod}: ${count}`);
    }
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
