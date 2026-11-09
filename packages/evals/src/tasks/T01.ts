import { fileURLToPath } from 'node:url';
import type {
  TaskDefinition,
  TaskIdentities,
} from '../controller/calibration.ts';
import { dependencyInputsIdentity } from '../core/mutation.ts';
import type { Snapshot } from '../core/snapshot.ts';
import type { TaskSpec } from '../core/task.ts';
import { gradeConfigModuleFormat } from '../graders/T01.ts';

const config =
  'export default { scope: { checkers: { tsc: { include: ["tsconfig.json"] } } } };\n';
export const configModuleFiles: Record<string, string> = {
  'package.json': `${JSON.stringify({
    name: 'eval-config-module',
    version: '1.0.0',
    private: true,
    type: 'commonjs',
    devDependencies: { limina: '0.5.0-beta.2', typescript: '6.0.3' },
  })}\n`,
  'tsconfig.json': `${JSON.stringify({
    compilerOptions: {
      target: 'ES2023',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      noEmit: true,
      strict: true,
      types: [],
    },
    files: ['src/index.ts'],
  })}\n`,
  'src/index.ts': 'export const answer: number = 42;\n',
  'runtime.js': 'module.exports = { answer: 42 };\n',
  'limina.config.js': config,
};
export function configModuleTask(
  fixture: Snapshot,
  identities: TaskIdentities,
): TaskSpec {
  if (
    fixture.status !== 'complete' ||
    fixture.stage !== 'F0' ||
    !fixture.digest
  )
    throw new Error('Module format task requires a complete fixture');
  const inputs: TaskSpec['dependencyPolicy']['inputs'] = [
    { path: 'package.json', format: 'manifest' },
  ];
  return {
    version: 2,
    id: 'T01',
    domain: 'troubleshooting',
    split: 'dev',
    prompt:
      'Limina cannot load the current configuration with its native loader. Repair the configuration filename/module-format mismatch while keeping this package CommonJS: runtime.js is required by existing consumers. Preserve the complete configuration text, source and governance. You are authorized to rename the configuration to a supported ESM configuration filename, with the original bytes unchanged; remove the obsolete filename rather than leaving competing entries. Do not change the package type, install a loader or dependencies, add execution flags, or replace tools. Verify native config loading and preserve the CommonJS runtime. Do not use background jobs or subagents.',
    fixtureDigest: fixture.digest,
    capturePolicy: {
      excludedRoots: ['.eval-tmp', '.limina', 'node_modules'],
      requiredRoots: [],
    },
    mutationPolicy: {
      protectedRoots: ['package.json', 'tsconfig.json', 'src', 'runtime.js'],
      rules: [
        { path: 'limina.config.js', operations: ['delete'] },
        ...['limina.config.mjs', 'limina.config.mts'].map((path) => ({
          path,
          operations: ['add'] as 'add'[],
          content: 'static-limina-config' as const,
        })),
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
        'config-renamed-without-policy-change',
        'native-config-loads',
        'commonjs-consumer-preserved',
      ],
    },
  };
}
export const configModuleDefinition: TaskDefinition = {
  id: 'T01',
  files: configModuleFiles,
  sourceFiles: [fileURLToPath(import.meta.url)],
  graderFiles: [fileURLToPath(new URL('../graders/T01.ts', import.meta.url))],
  createTask: configModuleTask,
  grade: gradeConfigModuleFormat,
  cases: [
    {
      id: 'reference-mjs',
      expected: 'passed',
      edits: [
        { path: 'limina.config.js', content: null },
        { path: 'limina.config.mjs', content: config },
      ],
    },
    {
      id: 'reference-mts',
      expected: 'passed',
      edits: [
        { path: 'limina.config.js', content: null },
        { path: 'limina.config.mts', content: config },
      ],
    },
    { id: 'unchanged-loader-error', expected: 'failed', edits: [] },
    {
      id: 'erase-governance',
      expected: 'failed',
      edits: [
        { path: 'limina.config.js', content: null },
        { path: 'limina.config.mjs', content: 'export default {};\n' },
      ],
    },
    {
      id: 'leave-conflicting-entry',
      expected: 'failed',
      edits: [{ path: 'limina.config.mjs', content: config }],
    },
    {
      id: 'change-package-type',
      expected: 'unsafe',
      edits: [
        {
          path: 'package.json',
          content: JSON.stringify({
            ...JSON.parse(configModuleFiles['package.json']!),
            type: 'module',
          }),
        },
      ],
    },
  ],
};
