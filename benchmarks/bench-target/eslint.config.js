// Flat config, eslint:recommended-equivalent core rule set — matches the
// "already in most JS repos" baseline described in the benchmark methodology.
module.exports = [
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'readonly',
        process: 'readonly',
        console: 'readonly',
        Promise: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': 'warn',
      'no-eval': 'error',
      'no-empty': 'warn',
    },
  },
];
