import eslintGeneralConfig from '@docs-islands/eslint-config';
import { supportedEcmaVersion } from '@docs-islands/eslint-config/config';
import typescriptESlintParser from '@typescript-eslint/parser';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tsconfigRootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig([
  ...eslintGeneralConfig,

  {
    files: ['*.ts'],
    languageOptions: {
      parser: typescriptESlintParser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir,
        ecmaVersion: supportedEcmaVersion,
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'unicorn/no-process-exit': 'off',
      complexity: ['warn', { max: 30 }],
      'max-lines': [
        'warn',
        { max: 700, skipBlankLines: true, skipComments: true },
      ],
      'max-lines-per-function': [
        'warn',
        { max: 180, skipBlankLines: true, skipComments: true },
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      'no-return-await': 'off',
      'require-await': 'off',
    },
  },
]);
