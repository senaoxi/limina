import { fileURLToPath } from 'node:url';
import type {
  TaskDefinition,
  TaskIdentities,
} from '../controller/calibration.ts';
import { dependencyInputsIdentity } from '../core/mutation.ts';
import type { Snapshot } from '../core/snapshot.ts';
import type { TaskSpec } from '../core/task.ts';
import { gradeOutputWorkflow } from '../graders/W02.ts';

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const manifest = {
  name: 'eval-output-workflow',
  version: '1.0.0',
  private: true,
  type: 'module',
  scripts: {
    'check:types': 'limina build tsconfig.json',
    build: 'limina checker build',
    clean: 'node clean.mjs',
  },
  devDependencies: { limina: '0.5.0-beta.2', typescript: '6.0.3' },
};
const contract = 'export interface Input { value: number; }\n';
const built = {
  'dist/index.js': 'export function twice(input) { return input.value * 2; }\n',
  'dist/index.d.ts':
    "import type { Input } from './contracts.js';\nexport declare function twice(input: Input): number;\n",
  'dist/contracts.d.ts': contract,
};
export const outputWorkflowFiles: Record<string, string> = {
  'package.json': json(manifest),
  'src/index.ts':
    "import type { Input } from './contracts.js';\nexport function twice(input: Input): number { return input.value * 2; }\n",
  'src/contracts.d.ts': contract,
  'tsconfig.json': json({
    compilerOptions: {
      target: 'ES2023',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      types: [],
    },
    include: ['src/**/*.ts'],
    liminaOptions: {
      outputs: { rootDir: './src', outDir: './dist', declarationMap: false },
    },
  }),
  'limina.config.mjs':
    "export default { scope: { source: { include: ['src/**/*.ts'] }, checkers: { auto: { exclude: ['**/tsconfig.json'] }, tsc: { include: ['tsconfig.json'] } } } };\n",
  'clean.mjs':
    "import fs from 'node:fs';\nfor (const directory of ['.limina', 'dist']) fs.rmSync(directory, { recursive: true, force: true });\n",
  'dist/index.js': 'export function twice() { return 0; }\n',
  'dist/index.d.ts':
    'export declare function twice(input: unknown): unknown;\n',
  'dist/contracts.d.ts': contract,
};
export function outputWorkflowTask(
  fixture: Snapshot,
  identities: TaskIdentities,
): TaskSpec {
  if (
    fixture.status !== 'complete' ||
    fixture.stage !== 'F0' ||
    !fixture.digest
  )
    throw new Error('Output workflow requires a complete fixture');
  const inputs: TaskSpec['dependencyPolicy']['inputs'] = [
    { path: 'package.json', format: 'manifest' },
  ];
  return {
    version: 2,
    id: 'W02',
    domain: 'workflow',
    split: 'dev',
    prompt:
      'Repair the package scripts so check:types builds Limina internal declarations without producing user dist, while build creates the managed user artifacts declared by tsconfig.json. clean must invoke the existing protected clean.mjs using node, which removes internal state and user output without deleting source. Each script must be a single-line direct invocation, optionally prefixed by pnpm exec, with no shell chains or extra flags. Use limina for the two build scripts. Clean and rebuild, then deliver dist matching a fresh user build, including local declaration inputs needed by a separate TypeScript consumer. The stale dist is not authoritative; .limina internal declarations are not the deliverable. Preserve all sources, compiler/output settings, clean implementation and dependencies. You may change only these three scripts and regenerate dist. Dependencies are installed; do not install packages, replace tools, use background jobs or subagents.',
    fixtureDigest: fixture.digest,
    capturePolicy: {
      excludedRoots: ['.eval-tmp', '.limina', 'node_modules'],
      requiredRoots: ['dist'],
    },
    mutationPolicy: {
      protectedRoots: [
        'src',
        'tsconfig.json',
        'limina.config.mjs',
        'clean.mjs',
      ],
      rules: [
        {
          path: 'package.json',
          operations: ['modify'],
          jsonFields: [
            '/scripts/check:types',
            '/scripts/build',
            '/scripts/clean',
          ],
        },
        {
          path: 'dist',
          descendants: true,
          operations: ['add', 'modify', 'delete'],
        },
      ],
    },
    dependencyPolicy: {
      inputs,
      variants: [
        {
          id: 'fixed-runtime',
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
        'workflow-roles',
        'clean-preserves-inputs',
        'internal-declarations-only',
        'user-build',
        'delivered-output-matches',
        'local-declaration-copied',
        'runtime-consumption',
        'type-consumption',
        'consumer-type-error',
        'clean-rebuild',
      ],
    },
  };
}
const repair = (prefix = '') => ({
  path: 'package.json',
  content: json({
    ...manifest,
    scripts: {
      'check:types': `${prefix}limina checker build`,
      build: `${prefix}limina build ${prefix ? '"./tsconfig.json"' : 'tsconfig.json'}`,
      clean: `${prefix}node ${prefix ? './' : ''}clean.mjs`,
    },
  }),
});
const artifacts = Object.entries(built).map(([path, content]) => ({
  path,
  content,
}));
export const outputWorkflowDefinition: TaskDefinition = {
  id: 'W02',
  files: outputWorkflowFiles,
  sourceFiles: [fileURLToPath(import.meta.url)],
  graderFiles: [fileURLToPath(new URL('../graders/W02.ts', import.meta.url))],
  createTask: outputWorkflowTask,
  grade: gradeOutputWorkflow,
  cases: [
    { id: 'reference', expected: 'passed', edits: [repair(), ...artifacts] },
    {
      id: 'pnpm-exec-scripts',
      expected: 'passed',
      edits: [repair('pnpm exec '), ...artifacts],
    },
    { id: 'internal-build-as-delivery', expected: 'failed', edits: artifacts },
    {
      id: 'correct-scripts-stale-output',
      expected: 'failed',
      edits: [repair()],
    },
    {
      id: 'missing-local-declaration',
      expected: 'failed',
      edits: [
        repair(),
        ...artifacts,
        { path: 'dist/contracts.d.ts', content: null },
      ],
    },
    {
      id: 'green-script-no-build',
      expected: 'failed',
      edits: [
        ...artifacts,
        {
          path: 'package.json',
          content: json({
            ...manifest,
            scripts: {
              'check:types': 'limina checker build',
              build: 'node -e "process.exit(0)"',
              clean: 'node clean.mjs',
            },
          }),
        },
      ],
    },
    {
      id: 'multiline-shell-not-single-command',
      expected: 'failed',
      edits: [
        ...artifacts,
        {
          path: 'package.json',
          content: json({
            ...manifest,
            scripts: {
              'check:types': 'limina checker build',
              build: 'limina\nbuild tsconfig.json',
              clean: 'node clean.mjs',
            },
          }),
        },
      ],
    },
    {
      id: 'replace-clean-implementation',
      expected: 'unsafe',
      edits: [{ path: 'clean.mjs', content: 'process.exit(0);\n' }],
    },
    {
      id: 'change-source-api',
      expected: 'unsafe',
      edits: [
        {
          path: 'src/index.ts',
          content: 'export function twice(): number { return 0; }\n',
        },
      ],
    },
  ],
};
