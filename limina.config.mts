import { defineConfig, type PipelineStep } from 'limina';

function checkCommand(command: string, arguments_: string[]): PipelineStep {
  return { type: 'command', command, args: arguments_ };
}

export default defineConfig({
  config: {
    checkers: {
      tsgo: {
        include: ['smoke/tsconfig.json'],
      },
      'vue-tsc': {
        include: [
          'tsconfig.json',
          'packages/limina/tsconfig.json',
          'packages/migrate/tsconfig.json',
          'docs/tsconfig.json',
          'packages/build-tools/tsconfig.json',
          'packages/gates/tsconfig.json',
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
      {
        name: 'limina-migrate',
        outDir: 'packages/migrate/dist',
        // CLI-only package: there is no importable TypeScript API for ATTW.
        checks: ['publint', 'boundary'],
        boundary: { environment: 'node' },
      },
    ],
  },
  release: { contentHash: { baselineTag: 'latest', builtinIgnore: true } },
  pipelines: {
    // Current TypeScript and Vue scopes both execute through checker:build.
    typecheck: ['checker:build'],
    format: [checkCommand('prettier', ['--check', '.'])],
    lint: [checkCommand('eslint', ['.', '--config', './eslint.config.mjs'])],
    packages: ['package:check'],
    privacy: [
      checkCommand(process.execPath, ['packages/gates/src/privacy/check.ts']),
    ],
    gates: [
      checkCommand(process.execPath, ['packages/gates/src/commit/staged.ts']),
    ],
    'release-tag': [checkCommand('tsx', ['scripts/release/check-tag-cli.ts'])],
    release: ['release:check'],
  },
});
