import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      tsgo: {
        include: [
          'packages/eslint-config/tsconfig.json',
          'smoke/tsconfig.json',
        ],
      },
      'vue-tsc': {
        include: [
          'tsconfig.json',
          'packages/limina/tsconfig.json',
          'docs/tsconfig.json',
          'packages/build-tools/tsconfig.json',
        ],
      },
    },
    source: {
      include: [
        '...',
        '**/*.js',
        '**/*.mjs',
        '**/*.cjs',
        '**/*.json',
        '**/*.vue',
        '**/.vitepress/**/*.ts',
        '**/.vitepress/**/*.vue',
      ],
      exclude: [
        '...',
        'vercel.json',
        '.prettierrc.json',
        'tsconfig.json',
        '**/tsconfig.*.json',
      ],
    },
  },
  regions: { extendNestedPackageScopes: true },
  source: { knip: true },
  package: {
    entries: [
      {
        name: 'limina',
        outDir: 'packages/limina/dist',
        boundary: { environment: 'node' },
      },
    ],
  },
  release: { contentHash: { baselineTag: 'latest', builtinIgnore: true } },
  pipelines: {
    // Main typecheck pipeline: run graph checks, source authority checks,
    // proof checks, and the configured checker entries.
    typecheck: [
      'graph:check',
      'source:check',
      'proof:check',
      'checker:build',
      'checker:typecheck',
    ],
    // Default TypeScript project-reference graph check.
    graph: [
      'graph:prepare',
      'graph:check',
      {
        type: 'command',
        command: 'tsgo',
        args: [
          '-b',
          '.limina/tsconfig/checkers/tsgo/tsconfig.build.json',
          '--pretty',
          'false',
        ],
      },
    ],
    // Production library/runtime declaration graph.
    lib: [
      'graph:prepare',
      {
        type: 'command',
        command: 'tsgo',
        args: [
          '-b',
          '.limina/tsconfig/checkers/tsgo/tsconfig.build.json',
          '--pretty',
          'false',
        ],
      },
    ],
    // Source-owned Vue SFC checks that are intentionally outside native tsc -b.
    vue: [
      'graph:prepare',
      {
        type: 'command',
        command: 'vue-tsc',
        args: [
          '-b',
          '.limina/tsconfig/checkers/vue-tsc/tsconfig.build.json',
          '--pretty',
          'false',
        ],
      },
    ],
    // Package artifact checks for dist output.
    package: ['package:check'],
    // Governance checks to run before publishing.
    publish: [
      'graph:check',
      'source:check',
      'proof:check',
      'package:check',
      'release:check',
    ],
  },
});
