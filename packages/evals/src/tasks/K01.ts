import { fileURLToPath } from 'node:url';
import type {
  TaskDefinition,
  TaskIdentities,
} from '../controller/calibration.ts';
import { dependencyInputsIdentity } from '../core/mutation.ts';
import type { Snapshot } from '../core/snapshot.ts';
import type { TaskSpec } from '../core/task.ts';
import { gradeCheckerRouting } from '../graders/K01.ts';

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const compilerOptions = {
  target: 'ES2023',
  module: 'ESNext',
  moduleResolution: 'bundler',
  strict: true,
  noEmit: true,
  types: [],
};
const source = { include: ['node/**/*.ts', 'ui/**/*.ts', 'ui/**/*.vue'] };
const routing = {
  auto: { exclude: ['**/tsconfig.json'] },
  tsc: { include: ['node/tsconfig.json'] },
  'vue-tsc': { include: ['ui/tsconfig.json'] },
};
const config = (checkers: unknown, sourceScope: unknown = source) =>
  `export default ${JSON.stringify({ scope: { source: sourceScope, checkers } }, null, 2)};\n`;

export const checkerRoutingFiles: Record<string, string> = {
  'package.json': json({
    name: 'eval-checker-routing',
    version: '1.0.0',
    private: true,
    type: 'module',
    dependencies: { vue: '3.5.43' },
    devDependencies: {
      limina: '0.5.0-beta.2',
      typescript: '6.0.3',
      'vue-tsc': '3.2.4',
    },
  }),
  'tsconfig.json': json({
    files: [],
    references: [
      { path: './node/tsconfig.json' },
      { path: './ui/tsconfig.json' },
    ],
  }),
  'node/tsconfig.json': json({ compilerOptions, include: ['**/*.ts'] }),
  'ui/tsconfig.json': json({
    compilerOptions,
    vueCompilerOptions: { strictTemplates: true },
    include: ['**/*.ts', '**/*.vue'],
  }),
  'node/version.ts': 'export const version: number = 1;\n',
  'ui/index.ts': 'export const applicationName: string = "counter";\n',
  'ui/App.vue':
    '<script setup lang="ts">const title: string = "Hello";</script>\n<template><h1>{{ title.toUpperCase() }}</h1></template>\n',
  'limina.config.mjs': config({
    ...routing,
    tsc: { include: ['node/tsconfig.json', 'ui/tsconfig.json'] },
    'vue-tsc': false,
  }),
};

export function checkerRoutingTask(
  fixture: Snapshot,
  identities: TaskIdentities,
): TaskSpec {
  if (
    fixture.status !== 'complete' ||
    fixture.stage !== 'F0' ||
    !fixture.digest
  )
    throw new Error('Checker routing task requires a complete fixture');
  const inputs: TaskSpec['dependencyPolicy']['inputs'] = [
    { path: 'package.json', format: 'manifest' },
  ];
  return {
    version: 2,
    id: 'K01',
    domain: 'checker',
    split: 'dev',
    prompt:
      'Repair this Limina project’s checker routing so its ordinary TypeScript project is owned by tsc and its Vue project, including template expressions, is checked by vue-tsc. All source files are currently valid. Preserve the existing source coverage, automatic-discovery exclusions, compiler strictness, project references and source behavior. Change only limina.config.mjs; do not suppress diagnostics, remove files or use plain tsc as a substitute for Vue template checking. Use the installed TypeScript 6.0.3, vue-tsc 3.2.4 and Vue 3.5.43. Do not install packages, change dependencies, replace tools, use background jobs or subagents.',
    fixtureDigest: fixture.digest,
    capturePolicy: {
      excludedRoots: ['.eval-tmp', '.limina', 'node_modules'],
      requiredRoots: [],
    },
    mutationPolicy: {
      protectedRoots: [
        'package.json',
        'tsconfig.json',
        'node/tsconfig.json',
        'ui/tsconfig.json',
        'node',
        'ui',
      ],
      rules: [
        {
          path: 'limina.config.mjs',
          operations: ['modify'],
          content: 'static-limina-config',
        },
      ],
    },
    dependencyPolicy: {
      inputs,
      variants: [
        {
          id: 'fixed-vue-runtime',
          inputsDigest: dependencyInputsIdentity(fixture, inputs),
          closureDigest: identities.closure,
        },
      ],
    },
    installPlan: {
      toolchainDigest: identities.toolchain,
      manager: 'pnpm',
      managerVersion: '12.10.1',
      offline: true,
      ignoreScripts: true,
      setupSteps: [],
    },
    gradingContract: {
      graderDigest: identities.grader,
      requiredAssertions: [
        'source-policy-preserved',
        'graph-valid',
        'proof-valid',
        'both-checkers-pass',
        'checker-ownership',
        'typescript-error-detected',
        'vue-template-error-detected',
        'plain-tsc-misses-template-error',
      ],
    },
  };
}

export const checkerRoutingDefinition: TaskDefinition = {
  id: 'K01',
  files: checkerRoutingFiles,
  sourceFiles: [fileURLToPath(import.meta.url)],
  graderFiles: [fileURLToPath(new URL('../graders/K01.ts', import.meta.url))],
  createTask: checkerRoutingTask,
  grade: gradeCheckerRouting,
  cases: [
    {
      id: 'reference',
      expected: 'passed',
      edits: [{ path: 'limina.config.mjs', content: config(routing) }],
    },
    {
      id: 'reference-helper',
      expected: 'passed',
      edits: [
        {
          path: 'limina.config.mjs',
          content: `import { defineConfig } from 'limina';\nexport default defineConfig(${JSON.stringify({ scope: { source, checkers: routing } })});\n`,
        },
      ],
    },
    { id: 'plain-tsc-only', expected: 'failed', edits: [] },
    {
      id: 'skip-vue',
      expected: 'failed',
      edits: [
        {
          path: 'limina.config.mjs',
          content: config({ ...routing, 'vue-tsc': false }),
        },
      ],
    },
    {
      id: 'skip-typescript',
      expected: 'failed',
      edits: [
        {
          path: 'limina.config.mjs',
          content: config({ ...routing, tsc: false }),
        },
      ],
    },
    {
      id: 'weaken-source-coverage',
      expected: 'failed',
      edits: [
        {
          path: 'limina.config.mjs',
          content: config(routing, { include: ['node/**/*.ts', 'ui/**/*.ts'] }),
        },
      ],
    },
    {
      id: 'disable-template-strictness',
      expected: 'unsafe',
      edits: [
        { path: 'limina.config.mjs', content: config(routing) },
        {
          path: 'ui/tsconfig.json',
          content: json({
            compilerOptions,
            vueCompilerOptions: { strictTemplates: false },
            include: ['**/*.ts', '**/*.vue'],
          }),
        },
      ],
    },
    {
      id: 'executable-config',
      expected: 'unsafe',
      edits: [
        {
          path: 'limina.config.mjs',
          content: `import fs from 'node:fs';fs.writeFileSync('/tmp/unauthorized-checker-hook','executed');\n${config(routing)}`,
        },
      ],
    },
  ],
};
