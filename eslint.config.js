import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Rules the specification requires to be machine-enforced (spec 13.3).
 *
 * A prose rule is followed unevenly by different people and different agents.
 * Anything that can be caught here is caught here, so `AGENTS.md` only has to
 * carry what genuinely cannot be automated.
 */
export default tseslint.config(
  // Anchored patterns only match the root, and wrangler leaves its temp
  // bundles under packages/api/.wrangler when it is run from there.
  { ignores: ['**/dist/**', '**/dist-types/**', '**/node_modules/**', '**/.wrangler/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],

      // Dates: the timezone belongs to the baby record, never the device,
      // and offset arithmetic silently ignores DST (spec 3.4, 5.3).
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'moment', message: 'Use the date utilities in @dongfan/shared.' },
          { name: 'moment-timezone', message: 'Use the date utilities in @dongfan/shared.' },
          { name: 'dayjs', message: 'Use the date utilities in @dongfan/shared.' },
        ],
      }],
      'no-restricted-syntax': ['error',
        {
          selector: "CallExpression > MemberExpression[property.name='getTimezoneOffset']",
          message: 'Device timezone must never decide a date. Use @dongfan/shared.',
        },
        {
          selector: "CallExpression > MemberExpression[property.name='toLocaleDateString']",
          message: 'Use toLocalDate from @dongfan/shared so the baby timezone is applied.',
        },
      ],
    },
  },
  {
    // The copy file is data, and its keys mirror stored ids.
    files: ['**/i18n/zh-TW.ts', '**/test/fixtures/**'],
    rules: { '@typescript-eslint/naming-convention': 'off' },
  },
  {
    // The shared package needs the DOM library for the web platform globals
    // that both the Worker and the browser implement (crypto, TextEncoder,
    // console). That also makes browser-only globals look available, so they
    // are banned here rather than relied on not being used.
    files: ['packages/shared/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error',
        { name: 'document', message: 'Shared code also runs in the Worker.' },
        { name: 'window', message: 'Shared code also runs in the Worker.' },
        { name: 'localStorage', message: 'Shared code also runs in the Worker.' },
        { name: 'navigator', message: 'Shared code also runs in the Worker.' },
      ],
    },
  },
  {
    // Build and maintenance scripts run under Node, not in a Worker.
    files: ['scripts/**/*.mjs', '*.config.{js,ts}'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
);
