import typescriptESlintParser from '@typescript-eslint/parser';
import eslintPluginPnpm from 'eslint-plugin-pnpm';
import type { defineConfig } from 'eslint/config';
import { globalIgnores } from 'eslint/config';
import {
  baseScriptFileRules,
  commonJsModuleGlobals,
  nodeEsmGlobals,
  supportedEcmaVersion,
  untypedModuleTypeScriptRules,
} from '../config/index.js';
import eslintGeneralConfig from '../general.js';

type Config = ReturnType<typeof defineConfig>;

/**
 * Root Directory ESLint Configuration
 *
 * IMPORTANT: CommonJS Module Policy
 * ==================================
 * This project does NOT promote the use of CommonJS modules.
 * CommonJS configuration is restricted to the monorepo root directory only.
 *
 * Rationale:
 * - The project follows modern ESM (ES Modules) standards throughout
 * - CommonJS is only retained for legacy tooling compatibility at the root level
 * - Root-level build scripts and configuration files may still require CommonJS
 * - All workspace packages and application code should use ESM exclusively
 *
 * If you need to write new configuration or scripts, prefer ESM (.mjs) over CommonJS (.cjs).
 */
const config: Config = [
  ...eslintGeneralConfig,

  globalIgnores(['packages/**', 'docs', 'utils']),

  // Root directory TypeScript script files
  {
    files: ['scripts/*.ts'],
    languageOptions: {
      parser: typescriptESlintParser,
      parserOptions: {
        projectService: true,
        ecmaVersion: supportedEcmaVersion,
        sourceType: 'module',
      },
      globals: {
        ...nodeEsmGlobals,
      },
    },
    rules: {
      ...baseScriptFileRules,
      // Root scripts have even higher complexity tolerance due to monorepo orchestration
      complexity: ['warn', { max: 40 }],
      'max-lines': [
        'warn',
        { max: 1200, skipBlankLines: true, skipComments: true },
      ],
      'max-lines-per-function': [
        'warn',
        { max: 240, skipBlankLines: true, skipComments: true },
      ],
    },
  },

  // CommonJS files configuration (Root directory only)
  {
    files: ['*.cjs'],
    languageOptions: {
      // CommonJS uses default Espree parser (not TypeScript parser)
      parserOptions: {
        ecmaVersion: supportedEcmaVersion,
        sourceType: 'commonjs',
      },
      globals: {
        ...nodeEsmGlobals,
        ...commonJsModuleGlobals,
      },
    },
    rules: {
      'no-restricted-globals': 'off',
      // CommonJS-appropriate styles
      'no-console': ['error'],
      'unicorn/prefer-module': 'off', // .cjs files using CommonJS is expected

      // Code quality rules
      'consistent-return': 'error', // Ensure consistent return values
      'no-param-reassign': ['error', { props: false }], // Allow modifying parameter properties
      'no-prototype-builtins': 'error', // Avoid direct use of Object.prototype methods
      'prefer-object-spread': 'error', // Use object spread
      'object-shorthand': 'error', // Use object shorthand

      // Security rules
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',

      // Complexity controls (moderately relaxed)
      complexity: ['warn', { max: 20 }],
      'max-lines-per-function': [
        'warn',
        { max: 150, skipBlankLines: true, skipComments: true },
      ],
      'max-lines': [
        'warn',
        { max: 800, skipBlankLines: true, skipComments: true },
      ],
      'max-depth': ['warn', 5],

      // Naming conventions
      camelcase: [
        'warn',
        {
          properties: 'never',
          ignoreDestructuring: true,
          allow: ['^npm_', '^PNPM_', '^NODE_'],
        },
      ],

      // Comment conventions
      'spaced-comment': ['error', 'always', { markers: ['/'] }],

      // Relaxed TypeScript rules
      ...untypedModuleTypeScriptRules,
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // .pnpmfile.cjs specific rules (Supplement general .cjs rules)
  {
    files: ['.pnpmfile.cjs'],
    rules: {
      // pnpm hooks specific: Allow modifying pkg parameter properties
      'no-param-reassign': [
        'error',
        {
          props: true,
          ignorePropertyModificationsFor: ['pkg'], // Required for pnpm readPackage hook
        },
      ],
    },
  },

  // pnpm-workspace.yaml specific rules
  {
    name: 'Pnpm Workspace',
    files: ['pnpm-workspace.yaml'],
    languageOptions: { parser: await import('yaml-eslint-parser') },
    plugins: { pnpm: eslintPluginPnpm },
    rules: {
      'pnpm/yaml-no-duplicate-catalog-item': [
        'error',
        {
          allow: ['vite'],
        },
      ],
      'pnpm/yaml-no-unused-catalog-item': 'error',
    },
  },
];

export default config;
