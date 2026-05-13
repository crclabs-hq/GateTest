/**
 * GateTest - Advanced QA Gate System
 *
 * Nothing ships unless it's pristine.
 * This is the main entry point for the GateTest library.
 */

const { GateTestConfig } = require('./core/config');
const { GateTestRunner, TestResult, Severity } = require('./core/runner');
const { ModuleRegistry } = require('./core/registry');
const { ClaudeMdParser } = require('./core/claude-md-parser');
const { ConsoleReporter } = require('./reporters/console-reporter');
const { JsonReporter } = require('./reporters/json-reporter');
const { HtmlReporter } = require('./reporters/html-reporter');
const { SarifReporter } = require('./reporters/sarif-reporter');
const { JunitReporter } = require('./reporters/junit-reporter');
const { GateTestCache } = require('./core/cache');
const {
  HostBridge,
  NotImplemented,
  CANONICAL_COMMIT_STATES,
  registerBridge,
  createBridge,
  listBridges,
} = require('./core/host-bridge');
// Importing the bridges registers each one in the HostBridge registry so
// callers of createBridge('github' | 'gluecron', ...) get a concrete
// implementation without needing to import it manually. Order matters only
// for the registry's "first wins on conflict" behaviour, which doesn't apply
// here since each bridge claims its own key.
const { GitHubBridge } = require('./core/github-bridge');
const { GluecronBridge } = require('./core/gluecron-bridge');

class GateTest {
  constructor(projectRoot, options = {}) {
    this.projectRoot = projectRoot || process.cwd();
    this.config = new GateTestConfig(this.projectRoot);
    this.registry = new ModuleRegistry();
    this.options = options;
  }

  /**
   * Initialize GateTest with all built-in modules.
   */
  init() {
    this.registry.loadBuiltIn();

    // Load custom modules from project
    const customDir = `${this.projectRoot}/.gatetest/modules`;
    this.registry.loadCustom(customDir);

    return this;
  }

  /**
   * Run a specific suite of tests.
   */
  async runSuite(suiteName = 'standard') {
    const modules = this.config.getSuite(suiteName);
    return this._run(modules);
  }

  /**
   * Run a specific module by name.
   */
  async runModule(moduleName) {
    return this._run([moduleName]);
  }

  /**
   * Run all registered modules.
   */
  async runAll() {
    const modules = this.registry.list();
    return this._run(modules);
  }

  /**
   * Validate the CLAUDE.md file.
   */
  validateClaudeMd() {
    const parser = new ClaudeMdParser(this.projectRoot);
    return parser.validate();
  }

  /**
   * Parse the CLAUDE.md file and return structured data.
   */
  parseClaudeMd() {
    const parser = new ClaudeMdParser(this.projectRoot);
    return parser.parse();
  }

  async _run(moduleNames) {
    const runner = new GateTestRunner(this.config, this.options);

    // Register modules
    const allModules = this.registry.getAll();
    for (const [name, mod] of allModules) {
      runner.register(name, mod);
    }

    // Attach reporters
    new ConsoleReporter(runner);
    new JsonReporter(runner, this.config);
    new HtmlReporter(runner, this.config);
    if (this.options.sarif) new SarifReporter(runner, this.config);
    if (this.options.junit) new JunitReporter(runner, this.config);

    // Run and return summary
    const summary = await runner.run(moduleNames);

    // Exit with non-zero if gate is blocked
    if (summary.gateStatus === 'BLOCKED' && this.config.get('gate.blockOnFailure')) {
      process.exitCode = 1;
    }

    return summary;
  }
}

module.exports = {
  GateTest,
  GateTestConfig,
  GateTestRunner,
  TestResult,
  Severity,
  ModuleRegistry,
  ClaudeMdParser,
  GateTestCache,
  ConsoleReporter,
  JsonReporter,
  HtmlReporter,
  SarifReporter,
  JunitReporter,
  // Host abstraction — Gluecron-first (CLAUDE.md → STRATEGIC DIRECTION).
  HostBridge,
  GitHubBridge,
  GluecronBridge,
  NotImplemented,
  CANONICAL_COMMIT_STATES,
  registerBridge,
  createBridge,
  listBridges,
};
