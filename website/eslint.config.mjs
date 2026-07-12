import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // React 19 hook-compiler rules are aspirational — they flag patterns
    // (setState-in-effect, manual-memoization preservation) that work fine
    // but could be restructured for the new compiler. Demote to warnings so
    // they show in lint output without blocking the gate while we
    // progressively migrate components.
    //
    // MUST stay scoped via `files` to code the react-hooks plugin actually
    // covers: an unscoped rules block references these rule ids on files
    // where the plugin namespace isn't defined, and ESLint 9 crashes with
    // exit 2 — which silently broke the lint module until the 2026-07-12
    // self-scan caught it.
    files: ["app/**/*.{js,jsx,ts,tsx}"],
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/purity": "warn",
    },
  },
  {
    // app/lib/*.js are CommonJS modules shared with the CLI engine. They
    // legitimately use require()/module.exports. Likewise some route.ts
    // files load these CJS modules via require() to bypass Turbopack tracing
    // of the dynamic CLI registry (see cli-engine-runner.js comment).
    files: ["app/lib/**/*.js", "app/lib/**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@next/next/no-assign-module-variable": "off",
    },
  },
  {
    files: ["app/api/**/route.ts", "app/api/**/route.tsx"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@next/next/no-assign-module-variable": "off",
    },
  },
  {
    // Sentry config files require the CJS scrubber module to share the same
    // scrub logic with the rest of the app. Keep these surfaces consistent
    // with the other lib-interop exceptions above.
    files: ["sentry.*.config.ts", "instrumentation*.ts"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
