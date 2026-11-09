import { dependencyInputsIdentity } from '../core/mutation.ts';
import type { Snapshot } from '../core/snapshot.ts';
import type { TaskSpec } from '../core/task.ts';

export const initializationFiles: Record<string, string> = {
  'package.json': `${JSON.stringify(
    {
      name: 'eval-init-app',
      version: '1.0.0',
      private: true,
      type: 'module',
      devDependencies: { limina: '0.5.0-beta.2', typescript: '6.0.3' },
    },
    null,
    2,
  )}\n`,
  'tsconfig.json': `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2023',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
      },
      include: ['src/**/*.ts'],
    },
    null,
    2,
  )}\n`,
  'src/index.ts': 'export const answer: number = 42;\n',
};

export function initializationTask(
  fixture: Snapshot,
  identities: { closure: string; toolchain: string; grader: string },
): TaskSpec {
  if (
    fixture.status !== 'complete' ||
    fixture.stage !== 'F0' ||
    !fixture.digest
  )
    throw new Error('Initialization requires a complete frozen fixture');
  const inputs: TaskSpec['dependencyPolicy']['inputs'] = [
    { path: 'package.json', format: 'manifest' },
  ];
  return {
    version: 2,
    id: 'I01',
    split: 'dev',
    domain: 'initialization',
    prompt:
      'Integrate Limina into this single-package TypeScript project. Initialize its configuration and package workflow, then finish the integration so the full Limina check succeeds and still catches real TypeScript errors. Preserve every existing source file and its contents. Preserve strict checking and production source coverage; do not add allowlists, skip checks, suppress diagnostics, or replace tools. The existing dependencies and installed toolchain are fixed; do not install packages or change dependency declarations. You may add a Limina config and .gitignore, update package scripts, and adjust tsconfig include and compilerOptions.types where needed. Use a data-only Limina config (an optional defineConfig import and a default object literal), with no executable setup or functions. Use the installed limina command. Do not use background jobs or subagents.',
    fixtureDigest: fixture.digest,
    capturePolicy: {
      excludedRoots: ['.eval-tmp', '.limina', 'node_modules'],
      requiredRoots: [],
    },
    mutationPolicy: {
      protectedRoots: ['src'],
      rules: [
        {
          path: 'package.json',
          operations: ['modify'],
          jsonFields: ['/scripts'],
        },
        {
          path: 'tsconfig.json',
          operations: ['modify'],
          jsonFields: ['/include', '/compilerOptions/types'],
        },
        { path: '.gitignore', operations: ['add', 'modify'] },
        ...[
          'limina.config.mts',
          'limina.config.ts',
          'limina.config.mjs',
          'limina.config.js',
        ].map((file) => ({
          path: file,
          operations: ['add', 'modify'] as ('add' | 'modify')[],
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
        'source-preserved',
        'config-created',
        'workflow-created',
        'full-check',
        'type-error-detected',
      ],
    },
  };
}
