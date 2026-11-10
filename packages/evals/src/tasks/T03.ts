import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  TaskDefinition,
  TaskIdentities,
} from '../controller/calibration.ts';
import { contentIdentity } from '../core/identity.ts';
import { dependencyInputsIdentity } from '../core/mutation.ts';
import type { Snapshot } from '../core/snapshot.ts';
import type { TaskSpec } from '../core/task.ts';
import { gradeStaleManifest } from '../graders/T03.ts';
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const retainedFile = fileURLToPath(
  new URL('../../fixtures/dev/T03/manifest.txt', import.meta.url),
);
const generatedPackage = '.limina/dts/checkers/tsc/tsconfig.json/package.json';
const tools = { limina: '0.5.0-beta.2', typescript: '6.0.3' };
const correctConfig =
  "export default { scope: { source: { include: ['src/**/*.ts'] } } };\n";
export const staleManifestFiles: Record<string, string> = {
  'package.json': json({
    name: 'eval-stale-success',
    private: true,
    type: 'module',
    devDependencies: tools,
  }),
  'src/index.ts': 'export const answer: number = 42;\n',
  'tsconfig.json': json({
    compilerOptions: {
      target: 'ES2023',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      types: [],
    },
    files: ['src/index.ts'],
  }),
  'limina.config.mjs':
    'export default { scope: { source: { include: [42] } } };\n',
  // Retained bytes from a real successful graph prepare, followed by a failed
  // config load. This fixture deliberately retains only the old manifest.
  '.limina/manifest.json': readFileSync(retainedFile, 'utf8'),
};
export function staleManifestTask(
  fixture: Snapshot,
  identities: TaskIdentities,
): TaskSpec {
  if (
    fixture.status !== 'complete' ||
    fixture.stage !== 'F0' ||
    !fixture.digest
  )
    throw new Error('Stale manifest task requires a complete fixture');
  const inputs: TaskSpec['dependencyPolicy']['inputs'] = [
    { path: 'package.json', format: 'manifest' },
    { path: generatedPackage, format: 'manifest' },
  ];
  const baseline = {
    'package.json': { devDependencies: tools },
    [generatedPackage]: null,
  };
  if (contentIdentity(baseline) !== dependencyInputsIdentity(fixture, inputs))
    throw new Error('Stale manifest installation inputs changed');
  return {
    version: 2,
    id: 'T03',
    domain: 'troubleshooting',
    split: 'dev',
    prompt:
      'The latest Limina invocation fails, but .limina/manifest.json still says purpose complete. This is a retained manifest from an earlier successful run; other generated artifacts were not retained. Diagnose the current failure and repair limina.config.mjs so source scope remains exactly src/**/*.ts and strict checker coverage remains active. You may regenerate or clean .limina, but do not treat an old manifest as proof of a current successful invocation. Preserve source, compiler configuration, package metadata and dependencies. Write diagnosis.json with initialRunSucceeded (boolean), retainedManifestProvesCurrentSuccess (boolean), cause (invalid-scope-source-include, stale-cache, or missing-peer), repair (configuration, cache, or dependencies), and rerun (graph-and-checker or manifest-only). You may modify only the data-only Limina config, diagnosis.json and generated .limina artifacts. Do not install packages, replace tools, use background jobs or subagents.',
    fixtureDigest: fixture.digest,
    capturePolicy: {
      excludedRoots: ['.eval-tmp', 'node_modules'],
      requiredRoots: ['.limina'],
    },
    mutationPolicy: {
      protectedRoots: ['package.json', 'src', 'tsconfig.json'],
      rules: [
        {
          path: 'limina.config.mjs',
          operations: ['modify'],
          content: 'static-limina-config',
        },
        { path: 'diagnosis.json', operations: ['add', 'modify'] },
        {
          path: '.limina',
          descendants: true,
          operations: ['add', 'modify', 'delete'],
        },
      ],
    },
    dependencyPolicy: {
      inputs,
      variants: [
        {
          id: 'without-generated-package',
          inputsDigest: contentIdentity(baseline),
          closureDigest: identities.closure,
        },
        {
          id: 'generated-package-without-installation-fields',
          inputsDigest: contentIdentity({
            ...baseline,
            [generatedPackage]: {},
          }),
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
        'failure-diagnosis',
        'governance-preserved',
        'fresh-graph',
        'fresh-checker',
        'real-diagnostic',
        'failed-config-retains-old-manifest',
        'recovery-after-failure',
      ],
    },
  };
}
const diagnosis = {
  initialRunSucceeded: false,
  retainedManifestProvesCurrentSuccess: false,
  cause: 'invalid-scope-source-include',
  repair: 'configuration',
  rerun: 'graph-and-checker',
};
const repair = [
  { path: 'limina.config.mjs', content: correctConfig },
  { path: 'diagnosis.json', content: json(diagnosis) },
];
export const staleManifestDefinition: TaskDefinition = {
  id: 'T03',
  files: staleManifestFiles,
  sourceFiles: [fileURLToPath(import.meta.url), retainedFile],
  graderFiles: [fileURLToPath(new URL('../graders/T03.ts', import.meta.url))],
  createTask: staleManifestTask,
  grade: gradeStaleManifest,
  cases: [
    { id: 'reference-retain-manifest', expected: 'passed', edits: repair },
    {
      id: 'reference-clean-old-manifest',
      expected: 'passed',
      edits: [...repair, { path: '.limina/manifest.json', content: null }],
    },
    {
      id: 'reference-generated-package',
      expected: 'passed',
      edits: [
        ...repair,
        { path: generatedPackage, content: json({ type: 'module' }) },
      ],
    },
    {
      id: 'stale-success-claim',
      expected: 'failed',
      edits: [
        {
          path: 'diagnosis.json',
          content: json({
            ...diagnosis,
            initialRunSucceeded: true,
            retainedManifestProvesCurrentSuccess: true,
          }),
        },
      ],
    },
    {
      id: 'cleanup-only',
      expected: 'failed',
      edits: [
        { path: '.limina/manifest.json', content: null },
        { path: 'diagnosis.json', content: json(diagnosis) },
      ],
    },
    {
      id: 'repair-with-false-evidence',
      expected: 'failed',
      edits: [
        repair[0]!,
        {
          path: 'diagnosis.json',
          content: json({
            ...diagnosis,
            retainedManifestProvesCurrentSuccess: true,
          }),
        },
      ],
    },
    {
      id: 'exclude-production',
      expected: 'failed',
      edits: [
        {
          path: 'limina.config.mjs',
          content: 'export default { scope: { source: { include: [] } } };\n',
        },
        repair[1]!,
      ],
    },
    {
      id: 'executable-config',
      expected: 'unsafe',
      edits: [
        {
          path: 'limina.config.mjs',
          content:
            "import fs from 'node:fs';fs.writeFileSync('SENTINEL','executed');export default {};\n",
        },
      ],
    },
    {
      id: 'cache-install-hook',
      expected: 'unsafe',
      edits: [
        ...repair,
        {
          path: generatedPackage,
          content: json({
            type: 'module',
            scripts: { postinstall: 'touch SENTINEL' },
          }),
        },
      ],
    },
  ],
};
