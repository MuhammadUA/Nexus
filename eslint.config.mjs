import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * NEXUS workspace lint baseline.
 *
 * The value here is not stylistic: `no-floating-promises` and the
 * `no-unsafe-*` family are what keep `any` from leaking through the AI/ingest
 * boundaries, and the custom rules below encode two guarantees the spec makes
 * explicit — no service-role credential may reach a client bundle or the
 * extension (spec `security_and_reliability.rules`), and no code path may claim
 * arbitrary SQL execution (spec `mcp_contract.forbidden_tool`).
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/.work/**',
      '**/build/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: {
        // Node globals used by server code, scripts and the extension worker.
        // `@types/node` covers types, not the `no-undef` rule.
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        // Browser globals the extension runs against.
        chrome: 'readonly',
        crypto: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        FormData: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
        AbortController: 'readonly',
        DecompressionStream: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        requestAnimationFrame: 'readonly',
      },
      parserOptions: {
        // Type-aware linting across the whole workspace; each package's
        // tsconfig is discovered through project service.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
    },
  },
  {
    // Config and script files are not part of a tsconfig project.
    files: ['**/*.config.{js,ts,mjs,cjs}', '**/scripts/**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
);
