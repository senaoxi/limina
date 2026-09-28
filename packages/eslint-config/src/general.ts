import eslint from '@eslint/js';
import htmlESlintPlugin from '@html-eslint/eslint-plugin';
import htmlESlintParser from '@html-eslint/parser';
import gitignore from 'eslint-config-flat-gitignore';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import eslintPluginN from 'eslint-plugin-n';
import eslintPluginPnpm from 'eslint-plugin-pnpm';
import eslintPluginPrettier from 'eslint-plugin-prettier';
import eslintPluginRegexp from 'eslint-plugin-regexp';
import eslintPluginUnicorn from 'eslint-plugin-unicorn';
import type { defineConfig } from 'eslint/config';
import { globalIgnores } from 'eslint/config';
import globals from 'globals';
import typescriptESlint from 'typescript-eslint';
import {
  baseTestFileRules,
  esmRestrictedNodeGlobals,
  javascriptFiles,
  markdownVirtualFiles,
  nodeEsmGlobals,
  nodeFilePatterns,
  supportedEcmaGlobals,
  supportedEcmaVersion,
  supportedNodeVersion,
  testFilePatterns,
  typescriptFiles,
  untypedModuleTypeScriptRules,
} from './config/index.js';

type Config = ReturnType<typeof defineConfig>;
type Rules = NonNullable<Config[number]['rules']>;

const typeCheckedTypeScriptRules: Rules = {
  '@typescript-eslint/consistent-type-imports': [
    'error',
    {
      prefer: 'type-imports',
      fixStyle: 'separate-type-imports',
    },
  ],
  '@typescript-eslint/no-import-type-side-effects': 'error',
  '@typescript-eslint/consistent-type-exports': [
    'error',
    {
      fixMixedExportsWithInlineTypeSpecifier: true,
    },
  ],
};

export default [
  eslint.configs.recommended,
  ...typescriptESlint.configs.recommended,
  ...typescriptESlint.configs.stylistic,
  eslintPluginRegexp.configs['flat/recommended'],
  eslintPluginUnicorn.configs.recommended,

  gitignore(),
  globalIgnores([
    '**/.DS_Store',
    '**/node_modules/**',
    '**/cache/**',
    '**/dist/**',
    '**/public/**',
    '**/coverage/**',
    // VitePress may emit transient compiled config modules beside the source config.
    '**/.vitepress/config.ts.timestamp-*.mjs',
  ]),

  {
    name: 'Global Base',
    languageOptions: {
      ecmaVersion: supportedEcmaVersion,
      globals: {
        ...supportedEcmaGlobals,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.name='process'][property.name='env']",
          message:
            'Direct process access is restricted. Import helpers from @docs-islands/utils instead.',
        },
      ],
      'no-console': ['error'],
      'array-callback-return': ['error', { allowImplicit: true }],
      'block-scoped-var': 'error',
      complexity: ['warn', { max: 20 }],
      'consistent-return': 'error',
      curly: ['error', 'multi-line'],
      'default-case-last': 'error',
      'dot-notation': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'guard-for-in': 'error',
      'no-alert': 'error',
      'no-array-constructor': 'error',
      'no-caller': 'error',
      'no-case-declarations': 'error',
      'no-constant-condition': [
        'error',
        {
          checkLoops: false,
        },
      ],
      'no-constructor-return': 'error',
      'no-continue': 'off',
      'no-else-return': ['error', { allowElseIf: false }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-empty-function': 'error',
      'no-eval': 'error',
      'no-extend-native': 'error',
      'no-extra-bind': 'error',
      'no-implicit-coercion': 'error',
      'no-implied-eval': 'error',
      'no-iterator': 'error',
      'no-labels': 'error',
      'no-lone-blocks': 'error',
      'no-lonely-if': 'error',
      'no-loop-func': 'error',
      'no-multi-assign': 'error',
      'no-new': 'error',
      'no-new-func': 'error',
      'no-new-object': 'error',
      'no-new-wrappers': 'error',
      'no-octal-escape': 'error',
      'no-param-reassign': ['error', { props: false }],
      'no-proto': 'error',
      'no-prototype-builtins': 'off',
      'no-return-assign': ['error', 'except-parens'],
      'no-return-await': 'off',
      'no-script-url': 'error',
      'no-self-compare': 'error',
      'no-sequences': 'error',
      'no-throw-literal': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-unused-expressions': [
        'error',
        { allowShortCircuit: true, allowTernary: true },
      ],
      'no-useless-call': 'error',
      'no-useless-concat': 'error',
      'no-useless-return': 'error',
      'no-var': 'error',
      'no-void': 'error',
      'object-shorthand': ['error', 'always'],
      'one-var': ['error', 'never'],
      'prefer-arrow-callback': 'error',
      'prefer-const': [
        'error',
        {
          destructuring: 'all',
          ignoreReadBeforeAssign: true,
        },
      ],
      'prefer-exponentiation-operator': 'error',
      'prefer-object-spread': 'error',
      'prefer-promise-reject-errors': 'error',
      'prefer-rest-params': 'error',
      'prefer-spread': 'error',
      'prefer-template': 'error',
      radix: 'error',
      'require-await': 'off',
      'sort-imports': [
        'error',
        {
          ignoreCase: true,
          ignoreDeclarationSort: true,
          ignoreMemberSort: false,
          memberSyntaxSortOrder: ['none', 'all', 'multiple', 'single'],
        },
      ],
      'spaced-comment': ['error', 'always', { markers: ['/'] }],
      yoda: 'error',

      'unicorn/better-regex': 'error',
      'unicorn/consistent-destructuring': 'error',
      'unicorn/filename-case': 'off',
      'unicorn/no-array-reduce': 'off',
      'unicorn/no-lonely-if': 'off',
      'unicorn/no-null': 'off',
      'unicorn/no-unused-properties': 'off',
      'unicorn/prefer-json-parse-buffer': 'off',
      'unicorn/prefer-native-coercion-functions': 'off',
      'unicorn/prefer-top-level-await': 'off',
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/require-post-message-target-origin': 'off',
      'unicorn/string-content': 'off',
      'unicorn/template-indent': 'warn',

      'regexp/prefer-regexp-exec': 'error',
      'regexp/prefer-regexp-test': 'error',
      'regexp/use-ignore-case': 'off',
    },
  },

  {
    name: 'Node.js',
    files: nodeFilePatterns,
    languageOptions: {
      globals: {
        ...nodeEsmGlobals,
      },
    },
    settings: {
      node: {
        version: supportedNodeVersion,
      },
    },
    plugins: {
      n: eslintPluginN,
    },
    rules: {
      'no-restricted-globals': [
        'error',
        ...esmRestrictedNodeGlobals.map((name) => ({
          name,
          message:
            'This project is ESM-first. CommonJS globals are only allowed in explicit .cjs files.',
        })),
      ],
      'n/hashbang': 'error',
      'n/no-extraneous-import': 'error',
      'n/no-extraneous-require': 'error',
      'n/no-exports-assign': 'error',
      'n/no-unpublished-bin': 'error',
      'n/no-unsupported-features/es-builtins': 'error',
      'n/no-unsupported-features/node-builtins': [
        'error',
        {
          ignores: ['Response', 'Request', 'fetch'],
        },
      ],
      'n/process-exit-as-throw': 'error',
    },
  },

  {
    name: 'Test Files',
    files: testFilePatterns,
    ignores: markdownVirtualFiles,
    languageOptions: {
      parser: typescriptESlint.parser,
      parserOptions: {
        ecmaVersion: supportedEcmaVersion,
        projectService: true,
        sourceType: 'module',
      },
      globals: {
        ...globals.browser,
        ...nodeEsmGlobals,
        ...globals.vitest,
      },
    },
    rules: baseTestFileRules,
  },

  {
    name: 'TypeScript Typed',
    files: typescriptFiles,
    ignores: [...markdownVirtualFiles, ...testFilePatterns],
    languageOptions: {
      parser: typescriptESlint.parser,
      parserOptions: {
        sourceType: 'module',
        ecmaVersion: supportedEcmaVersion,
        isolatedDeclarations: true,
        projectService: true,
      },
    },
    plugins: {
      '@typescript-eslint': typescriptESlint.plugin,
    },
    rules: typeCheckedTypeScriptRules,
  },

  {
    name: 'JavaScript',
    files: javascriptFiles,
    languageOptions: {
      parserOptions: {
        sourceType: 'module',
        ecmaVersion: supportedEcmaVersion,
      },
    },
    rules: {
      ...untypedModuleTypeScriptRules,
      'unicorn/prefer-module': 'off',
      'no-return-await': 'off',
      'require-await': 'off',
      complexity: 'off',
      'max-lines': [
        'warn',
        { max: 800, skipBlankLines: true, skipComments: true },
      ],
      'max-lines-per-function': 'off',
    },
  },

  {
    name: 'HTML',
    files: ['**/*.html'],
    plugins: { html: htmlESlintPlugin },
    languageOptions: {
      parser: htmlESlintParser,
    },
    settings: {
      'html/javascript-mime-types': ['text/javascript', 'text/jsx'],
    },
    rules: {
      'html/indent': ['error', 2],
      'html/quotes': ['error', 'double'],
      'html/no-trailing-spaces': 'error',
      'html/no-multiple-empty-lines': ['error', { max: 1 }],
      'html/require-doctype': 'error',
      'html/require-lang': 'error',
      'html/no-duplicate-attrs': 'error',
      'html/no-obsolete-tags': 'warn',
      'html/require-attrs': 'off',
      'html/require-closing-tags': 'error',
      'html/require-li-container': 'error',
      'html/no-duplicate-id': 'error',
      'html/no-extra-spacing-attrs': 'error',
    },
  },

  {
    name: 'Declaration Files',
    files: ['**/*.d.ts', '**/*.d.mts', '**/*.d.cts'],
    rules: {
      '@typescript-eslint/consistent-indexed-object-style': 'off',
      '@typescript-eslint/triple-slash-reference': 'off',
    },
  },

  {
    name: 'Pnpm Package.json',
    files: ['package.json', '**/package.json'],
    languageOptions: { parser: await import('jsonc-eslint-parser') },
    plugins: { pnpm: eslintPluginPnpm },
    rules: {
      'pnpm/json-enforce-catalog': 'error',
      'pnpm/json-prefer-workspace-settings': 'error',
      'pnpm/json-valid-catalog': 'error',
    },
  },

  {
    name: 'Formatting',
    plugins: { prettier: eslintPluginPrettier },
    rules: {
      'prettier/prettier': ['error', {}, { usePrettierrc: true }],
    },
  },
  eslintConfigPrettier,
] as Config;
