import { fileURLToPath } from 'node:url';
import type {
  TaskDefinition,
  TaskIdentities,
} from '../controller/calibration.ts';
import { dependencyInputsIdentity } from '../core/mutation.ts';
import type { Snapshot } from '../core/snapshot.ts';
import type { TaskSpec } from '../core/task.ts';
import { gradeDeclarationConditions } from '../graders/R02.ts';

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const compilerOptions = {
  target: 'ES2023',
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
  strict: true,
  noEmit: true,
  types: [],
};
const consumer = (conditions: string[]) =>
  json({
    compilerOptions: { ...compilerOptions, customConditions: conditions },
    files: ['consumer/index.ts'],
  });
export const declarationConditionFiles: Record<string, string> = {
  'package.json': json({
    name: 'eval-local-artifact',
    version: '1.0.0',
    private: true,
    type: 'module',
    exports: {
      '.': {
        source: './src/index.ts',
        types: './dist/index.d.ts',
        import: './dist/index.js',
      },
    },
    devDependencies: { limina: '0.5.0-beta.2', typescript: '6.0.3' },
  }),
  'dist/package.json': json({
    name: 'eval-local-artifact',
    version: '1.0.0',
    type: 'module',
    exports: { '.': { types: './index.d.ts', import: './index.js' } },
  }),
  'dist/index.d.ts': 'export declare function format(value: number): string;\n',
  'dist/index.js': 'export function format(value) { return String(value); }\n',
  'src/index.ts':
    'export function format(value: number): number { return value; }\n',
  'consumer/index.ts':
    "import { format } from 'eval-local-artifact';\nexport const result: string = format(42);\n",
  'tsconfig.json': json({
    files: [],
    references: [
      { path: './tsconfig.library.json' },
      { path: './tsconfig.consumer.json' },
    ],
  }),
  'tsconfig.library.json': json({ compilerOptions, files: ['src/index.ts'] }),
  'tsconfig.consumer.json': consumer(['source']),
  'limina.config.mjs':
    "export default { scope: { source: { include: ['src/**/*.ts', 'consumer/**/*.ts'] }, checkers: { auto: { exclude: ['**/tsconfig.json'] }, tsc: { include: ['tsconfig.json'] } } } };\n",
};
export function declarationConditionTask(
  fixture: Snapshot,
  identities: TaskIdentities,
): TaskSpec {
  if (
    fixture.status !== 'complete' ||
    fixture.stage !== 'F0' ||
    !fixture.digest
  )
    throw new Error('Declaration condition task requires a complete fixture');
  const inputs: TaskSpec['dependencyPolicy']['inputs'] = [
    { path: 'package.json', format: 'manifest' },
    { path: 'dist/package.json', format: 'manifest' },
  ];
  return {
    version: 2,
    id: 'R02',
    domain: 'reference-graph',
    split: 'dev',
    prompt:
      'The compatibility consumer must use the checked-in built API and declarations of eval-local-artifact, even though a newer source API exists locally. Its current compiler export conditions select the wrong surface. Repair only tsconfig.consumer.json compilerOptions.customConditions so consumer/index.ts typechecks against dist/index.d.ts and runs against dist/index.js. Preserve both export surfaces, all source and built files, strict checking, solution membership and source coverage. Do not turn the local built/declaration consumption into a source project reference, rewrite the consumer, regenerate dist, or change the library compiler settings. Dependencies are already installed. Do not install packages, replace tools, use background jobs or subagents.',
    fixtureDigest: fixture.digest,
    capturePolicy: {
      excludedRoots: ['.eval-tmp', '.limina', 'node_modules'],
      requiredRoots: ['dist'],
    },
    mutationPolicy: {
      protectedRoots: [
        'package.json',
        'dist',
        'src',
        'consumer',
        'tsconfig.json',
        'tsconfig.library.json',
        'limina.config.mjs',
      ],
      rules: [
        {
          path: 'tsconfig.consumer.json',
          operations: ['modify'],
          jsonFields: ['/compilerOptions/customConditions'],
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
        'declaration-target-selected',
        'graph-valid',
        'consumer-builds',
        'no-source-reference',
        'runtime-built-api',
        'declaration-diagnostic',
      ],
    },
  };
}
export const declarationConditionDefinition: TaskDefinition = {
  id: 'R02',
  files: declarationConditionFiles,
  sourceFiles: [fileURLToPath(import.meta.url)],
  graderFiles: [fileURLToPath(new URL('../graders/R02.ts', import.meta.url))],
  createTask: declarationConditionTask,
  grade: gradeDeclarationConditions,
  cases: [
    {
      id: 'reference-empty-conditions',
      expected: 'passed',
      edits: [{ path: 'tsconfig.consumer.json', content: consumer([]) }],
    },
    {
      id: 'reference-remove-option',
      expected: 'passed',
      edits: [
        {
          path: 'tsconfig.consumer.json',
          content: json({ compilerOptions, files: ['consumer/index.ts'] }),
        },
      ],
    },
    { id: 'source-condition-unchanged', expected: 'failed', edits: [] },
    {
      id: 'retain-source-condition',
      expected: 'failed',
      edits: [
        {
          path: 'tsconfig.consumer.json',
          content: consumer(['node', 'source']),
        },
      ],
    },
    {
      id: 'force-source-reference',
      expected: 'unsafe',
      edits: [
        {
          path: 'tsconfig.consumer.json',
          content: json({
            ...JSON.parse(consumer([])),
            references: [{ path: './tsconfig.library.json' }],
          }),
        },
      ],
    },
    {
      id: 'weaken-consumer-api',
      expected: 'unsafe',
      edits: [
        {
          path: 'consumer/index.ts',
          content:
            "import { format } from 'eval-local-artifact';\nexport const result: unknown = format(42);\n",
        },
      ],
    },
    {
      id: 'overwrite-built-declaration',
      expected: 'unsafe',
      edits: [
        {
          path: 'dist/index.d.ts',
          content: 'export declare function format(value: number): number;\n',
        },
      ],
    },
  ],
};
