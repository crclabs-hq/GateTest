/**
 * Zod Schema Presence — React components without runtime prop validation.
 *
 * In AI-generated codebases components often accept loose props with no
 * runtime validation. Adding Zod schemas provides:
 *   - Runtime validation at component boundaries.
 *   - Self-documenting prop shapes.
 *   - AI-generated props verified against the schema at runtime.
 *
 * This module flags React component files (.tsx) that:
 *   1. Export a default function/const/class (the component).
 *   2. Accept a props argument (not void/no-arg).
 *   3. Have no Zod schema import or schema variable present.
 *
 * "Schema present" means any of:
 *   - `import { z } from 'zod'` or `import * as z from 'zod'`
 *   - `z.object(`, `z.string(`, `z.infer`, `z.union(`
 *   - `PropTypes.` (React PropTypes as fallback)
 *   - A TypeScript interface/type for `Props` in the same file
 *     AND a runtime parse call (`schema.parse`, `schema.safeParse`)
 *
 * When ANTHROPIC_API_KEY is set and autoFix runs, Claude generates the
 * Zod schema for the component's props automatically.
 *
 * Suppression: `// zod-ok` anywhere in the file suppresses for that file.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const BaseModule    = require('./base-module');
const { makeAutoFix } = require('../core/ai-fix-engine');

// ─── patterns ─────────────────────────────────────────────────────────────

const ZOD_IMPORT_RE      = /import\s+(?:\*\s+as\s+z|\{[^}]*\bz\b[^}]*\})\s+from\s+['"]zod['"]/;
const ZOD_USAGE_RE       = /\bz\s*\.\s*(?:object|string|number|boolean|array|union|enum|literal|optional|nullable|infer|parse|safeParse|discriminatedUnion|record|tuple|function|lazy|any|unknown)\s*[([]/;
const PROPTYPES_RE       = /\bPropTypes\s*\./;
const PARSE_CALL_RE      = /\.\s*(?:parse|safeParse|parseAsync)\s*\(/;

// Exported default component: export default function Foo / export default class Foo / const Foo = ...
const COMPONENT_EXPORT_RE = /export\s+default\s+(?:(?:async\s+)?function|class)\s+([A-Z][a-zA-Z0-9]*)/;
const COMPONENT_CONST_RE  = /export\s+(?:default\s+)?(?:const|let)\s+([A-Z][a-zA-Z0-9]*)\s*(?::\s*(?:React\.)?FC|=\s*(?:\([^)]*\)\s*=>|\([^)]*\):\s*(?:React\.)?(?:JSX\.Element|ReactElement|ReactNode)))/;

// Props detection: function has at least one param that is not empty
const PROPS_PARAM_RE  = /(?:function\s+[A-Z][a-zA-Z0-9]*|=\s*(?:async\s*)?\(|=>\s*\{)\s*\(\s*\{/;
const TYPED_PROPS_RE  = /(?:function|const)\s+[A-Z][a-zA-Z0-9]*\s*(?::\s*(?:React\.)?FC\s*<|=\s*\(\s*props\s*:\s*[A-Z])/;

// ─── module ────────────────────────────────────────────────────────────────

class ZodSchemaPresence extends BaseModule {
  constructor() {
    super('zodSchemaPresence', 'Zod Schema Presence — flags React components without runtime prop validation');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;

    // Only applicable if zod is installed
    const pkgPath = path.join(projectRoot, 'package.json');
    let zodInstalled = false;
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        zodInstalled = !!(
          (pkg.dependencies || {}).zod ||
          (pkg.devDependencies || {}).zod
        );
      } catch { /* skip */ }
    }

    if (!zodInstalled) {
      result.addCheck('zod-schema:not-installed', true, {
        severity: 'info',
        message: 'Zod is not installed — schema presence check skipped. Consider adding zod for runtime prop validation.',
      });
      return;
    }

    const files = this._collectFiles(projectRoot, ['.tsx', '.jsx']);
    let checked = 0;
    let missing  = 0;

    for (const file of files) {
      const rel = path.relative(projectRoot, file);

      // Skip test files, stories, pages (they often don't export reusable components)
      if (
        rel.includes('.test.') || rel.includes('.spec.') ||
        rel.includes('.stories.') || rel.includes('__tests__') ||
        rel.endsWith('/page.tsx') || rel.endsWith('/layout.tsx') ||
        rel.endsWith('/loading.tsx') || rel.endsWith('/error.tsx') ||
        rel.includes('node_modules') || rel.includes('.next')
      ) continue;

      let content;
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      if (content.includes('// zod-ok')) continue;

      // Must have a component export
      if (!COMPONENT_EXPORT_RE.test(content) && !COMPONENT_CONST_RE.test(content)) continue;

      // Must accept props (not a no-arg component)
      const hasProps = PROPS_PARAM_RE.test(content) || TYPED_PROPS_RE.test(content);
      if (!hasProps) continue;

      checked++;

      // Check for schema presence
      const hasZod       = ZOD_IMPORT_RE.test(content) && ZOD_USAGE_RE.test(content);
      const hasPropTypes = PROPTYPES_RE.test(content);
      const hasParsing   = PARSE_CALL_RE.test(content);

      if (hasZod || hasPropTypes || hasParsing) continue;

      missing++;
      result.addCheck(`zod-schema:missing:${rel}`, false, {
        severity: 'warning',
        message: `Component in \`${rel}\` accepts props but has no Zod schema or PropTypes validation`,
        file: rel,
        fix: `Import zod (\`import { z } from 'zod'\`) and define a \`PropsSchema = z.object({ ... })\` for this component's props. Parse incoming props with \`PropsSchema.parse(props)\`.`,
        autoFix: makeAutoFix(
          file,
          'zod-schema:missing',
          `React component accepts props but has no Zod schema`,
          undefined,
          `Add a Zod schema: import { z } from 'zod'; then define const PropsSchema = z.object({...}) and use it to validate props`
        ),
      });
    }

    if (missing === 0 && checked > 0) {
      result.addCheck('zod-schema:all-validated', true, {
        severity: 'info',
        message: `All ${checked} props-accepting component(s) have schema validation`,
      });
    } else if (checked === 0) {
      result.addCheck('zod-schema:no-components', true, {
        severity: 'info',
        message: 'No props-accepting React components found',
      });
    }
  }
}

module.exports = ZodSchemaPresence;
