module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
    jest: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  rules: {
    // Keep initial adoption low-friction for this codebase.
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/ban-ts-comment': 'off',
    // Enforce indentation consistency as a blocking rule.
    indent: ['error', 'tab', { SwitchCase: 1 }],
    // Allow tabs for indentation with spaces for alignment in legacy blocks.
    'no-mixed-spaces-and-tabs': ['error', 'smart-tabs'],
    '@typescript-eslint/no-unused-vars': [
      'warn',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
    // --- Phase 1: TypeScript best practices (no type-aware linting required) ---
    // Enforce `import type` for type-only imports to eliminate phantom runtime deps.
    '@typescript-eslint/consistent-type-imports': [
      'error',
      { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
    ],
    // Prefer `a?.b` over `a && a.b` — reduces null-check boilerplate.
    '@typescript-eslint/prefer-optional-chain': 'error',
    // Catch type assertions that are no longer necessary.
    '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
    // Require all switch statements on union types to handle every member.
    // allowDefaultCaseForExhaustiveSwitch: when there is a `default:` case, treat it as
    // exhaustive — this covers switches on `string | undefined` where runtime fallback is fine.
    '@typescript-eslint/switch-exhaustiveness-check': ['error', { allowDefaultCaseForExhaustiveSwitch: true }],
  },
};
