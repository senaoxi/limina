import eslintGeneralConfig from '@docs-islands/eslint-config';
import {
  baseTestFileRules,
  testFilePatterns,
} from '@docs-islands/eslint-config/config';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  ...eslintGeneralConfig,

  {
    rules: {
      '@typescript-eslint/no-inferrable-types': 'off',
      complexity: ['warn', { max: 40 }],
      'no-console': 'off',
      'no-restricted-syntax': 'off',
      'unicorn/consistent-destructuring': 'off',
      'unicorn/consistent-function-scoping': 'off',
      'unicorn/no-array-callback-reference': 'off',
      'unicorn/no-array-sort': 'off',
      'unicorn/no-await-expression-member': 'off',
      'unicorn/no-object-as-default-parameter': 'off',
      'unicorn/prefer-spread': 'off',
    },
  },
  {
    files: testFilePatterns,
    rules: {
      ...baseTestFileRules,
      'unicorn/better-regex': 'off',
    },
  },
]);
