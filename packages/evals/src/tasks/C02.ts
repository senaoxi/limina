import { fileURLToPath } from 'node:url';
import type {
  TaskDefinition,
  TaskIdentities,
} from '../controller/calibration.ts';
import { dependencyInputsIdentity } from '../core/mutation.ts';
import type { Snapshot } from '../core/snapshot.ts';
import type { TaskSpec } from '../core/task.ts';
import { gradeEntryCoverage } from '../graders/C02.ts';

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const leaf = json({
  compilerOptions: {
    target: 'ES2023',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    noEmit: true,
    types: [],
  },
  files: ['index.ts'],
});
const solution = json({
  files: [],
  references: [
    { path: './tsconfig.lib.json' },
    { path: './tsconfig.test.json' },
  ],
});
const root = (api: string) =>
  json({
    files: [],
    references: [{ path: './client/tsconfig.json' }, { path: api }],
  });
const settings = (entry: string) =>
  json({
    scope: {
      source: { include: ['client/**/*.ts', 'api/**/*.ts'] },
      checkers: {
        auto: { exclude: ['**/tsconfig.json'] },
        tsc: { include: [entry] },
      },
    },
  });
export const entryCoverageFiles: Record<string, string> = {
  'package.json': json({
    name: 'eval-entry-coverage',
    version: '1.0.0',
    private: true,
    type: 'module',
    devDependencies: { limina: '0.5.0-beta.2', typescript: '6.0.3' },
  }),
  'limina.config.mjs':
    "import settings from './limina.settings.json' with { type: 'json' };\nexport default settings;\n",
  'limina.settings.json': settings('client/tsconfig.app.json'),
  'tsconfig.json': root('./api/tsconfig.solution.json'),
  'client/tsconfig.app.json': leaf,
  'client/tsconfig.json': json({
    files: [],
    references: [
      { path: './tsconfig.app.json' },
      { path: './tsconfig.test.json' },
    ],
  }),
  'client/tsconfig.test.json': json({
    ...JSON.parse(leaf),
    files: ['test.ts'],
  }),
  'client/test.ts': 'export const clientTest: boolean = true;\n',
  'client/index.ts': 'export const clientValue: number = 42;\n',
  'api/tsconfig.solution.json': solution,
  'api/tsconfig.lib.json': leaf,
  'api/tsconfig.test.json': json({ ...JSON.parse(leaf), files: ['test.ts'] }),
  'api/test.ts': 'export const apiTest: boolean = true;\n',
  'api/index.ts': 'export const apiValue: number = 24;\n',
};
export function entryCoverageTask(
  fixture: Snapshot,
  identities: TaskIdentities,
): TaskSpec {
  if (
    fixture.status !== 'complete' ||
    fixture.stage !== 'F0' ||
    !fixture.digest
  )
    throw new Error('Entry coverage requires a complete fixture');
  const inputs: TaskSpec['dependencyPolicy']['inputs'] = [
    { path: 'package.json', format: 'manifest' },
  ];
  return {
    version: 2,
    id: 'C02',
    domain: 'configuration',
    split: 'dev',
    prompt:
      'Repair the Limina checker entry configuration so the root solution covers both the client and API projects, including their test environments. Keep all four named leaf configs, preserve every source file and compiler option, and preserve the nested solution layers. Correct the checker selector in limina.settings.json and the solution filename/reference wiring. The API solution may be renamed to api/tsconfig.json; remove its obsolete name. Do not flatten the solution, drop a project, narrow source coverage or change checker ownership. The config module and dependencies are fixed. Dependencies are already installed; do not install anything or replace tools. Do not use background jobs or subagents.',
    fixtureDigest: fixture.digest,
    capturePolicy: {
      excludedRoots: ['.eval-tmp', '.limina', 'node_modules'],
      requiredRoots: [],
    },
    mutationPolicy: {
      protectedRoots: [
        'package.json',
        'limina.config.mjs',
        'client',
        'api/tsconfig.lib.json',
        'api/tsconfig.test.json',
        'api/test.ts',
        'api/index.ts',
      ],
      rules: [
        {
          path: 'limina.settings.json',
          operations: ['modify'],
          jsonFields: ['/scope/checkers/tsc/include'],
        },
        {
          path: 'tsconfig.json',
          operations: ['modify'],
          jsonFields: ['/references'],
        },
        { path: 'api/tsconfig.solution.json', operations: ['delete'] },
        { path: 'api/tsconfig.json', operations: ['add'] },
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
        'solution-structure-preserved',
        'graph-valid',
        'proof-valid',
        'both-leaves-owned',
        'both-leaves-typecheck',
        'client-diagnostic',
        'api-diagnostic',
      ],
    },
  };
}
const rename = [
  { path: 'api/tsconfig.solution.json', content: null },
  { path: 'api/tsconfig.json', content: solution },
  { path: 'tsconfig.json', content: root('./api/tsconfig.json') },
];
const selector = {
  path: 'limina.settings.json',
  content: settings('tsconfig.json'),
};
export const entryCoverageDefinition: TaskDefinition = {
  id: 'C02',
  files: entryCoverageFiles,
  sourceFiles: [fileURLToPath(import.meta.url)],
  graderFiles: [fileURLToPath(new URL('../graders/C02.ts', import.meta.url))],
  createTask: entryCoverageTask,
  grade: gradeEntryCoverage,
  cases: [
    { id: 'reference', expected: 'passed', edits: [...rename, selector] },
    {
      id: 'directory-references-and-reordered-json',
      expected: 'passed',
      edits: [
        ...rename,
        selector,
        {
          path: 'tsconfig.json',
          content: json({
            files: [],
            references: [{ path: 'api' }, { path: 'client' }],
          }),
        },
        {
          path: 'api/tsconfig.json',
          content: json({
            references: [
              { path: 'tsconfig.test.json' },
              { path: 'tsconfig.lib.json' },
            ],
            files: [],
          }),
        },
      ],
    },
    { id: 'unchanged', expected: 'failed', edits: [] },
    { id: 'selector-only', expected: 'failed', edits: [selector] },
    { id: 'rename-only', expected: 'failed', edits: rename },
    {
      id: 'drop-api-closure',
      expected: 'failed',
      edits: [
        ...rename,
        selector,
        {
          path: 'tsconfig.json',
          content: json({
            files: [],
            references: [{ path: './client/tsconfig.json' }],
          }),
        },
      ],
    },
    {
      id: 'flatten-api-solution',
      expected: 'failed',
      edits: [
        ...rename,
        selector,
        { path: 'api/tsconfig.json', content: leaf },
      ],
    },
    {
      id: 'narrow-source-scope',
      expected: 'unsafe',
      edits: [
        ...rename,
        {
          path: 'limina.settings.json',
          content: json({
            scope: {
              source: { include: ['client/**/*.ts'] },
              checkers: { tsc: { include: ['tsconfig.json'] } },
            },
          }),
        },
      ],
    },
  ],
};
