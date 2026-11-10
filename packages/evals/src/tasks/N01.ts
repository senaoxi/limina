import { dependencyInputsIdentity } from '../core/mutation.ts';
import type { Snapshot } from '../core/snapshot.ts';
import type { TaskSpec } from '../core/task.ts';

export const typescriptRepairFiles: Record<string, string> = {
  'package.json': `${JSON.stringify({ name: 'eval-greeting', version: '1.0.0', private: true, type: 'module', devDependencies: { typescript: '6.0.3' } }, null, 2)}\n`,
  'tsconfig.json': `${JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, types: [], outDir: 'dist', rootDir: 'src' }, include: ['src/**/*.ts'] }, null, 2)}\n`,
  'src/greet.ts':
    'export function greet(name: string): string {\n  return name.length;\n}\n',
};

export function typescriptRepairTask(
  fixture: Snapshot,
  identities: { closure: string; toolchain: string; grader: string },
): TaskSpec {
  if (
    fixture.status !== 'complete' ||
    fixture.stage !== 'F0' ||
    !fixture.digest
  )
    throw new Error('Repair requires a complete fixture');
  const inputs: TaskSpec['dependencyPolicy']['inputs'] = [
    { path: 'package.json', format: 'manifest' },
  ];
  return {
    version: 2,
    id: 'N01',
    domain: 'negative-control',
    split: 'dev',
    prompt:
      'Fix the TypeScript error in src/greet.ts. Keep the exported greet(name: string): string API. It must return "Hello, " followed by the trimmed name, or "Hello, stranger" when the trimmed name is empty. Preserve punctuation and non-ASCII characters in nonempty names. Change only src/greet.ts as project source; the compiler may regenerate dist/greet.js and its directory. Do not change project configuration or dependencies, install packages, suppress type checking, or add tools. Use the installed compiler to check the repair. Do not use background jobs or subagents.',
    fixtureDigest: fixture.digest,
    capturePolicy: {
      excludedRoots: ['.eval-tmp', '.limina', 'node_modules'],
      requiredRoots: ['dist'],
    },
    mutationPolicy: {
      protectedRoots: ['package.json', 'tsconfig.json'],
      rules: [
        { path: 'src/greet.ts', operations: ['modify'] },
        { path: 'dist', operations: ['add', 'modify', 'delete'] },
        { path: 'dist/greet.js', operations: ['add', 'modify', 'delete'] },
      ],
    },
    dependencyPolicy: {
      inputs,
      variants: [
        {
          id: 'fixed-typescript',
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
      requiredAssertions: ['compiler-accepts', 'runtime-semantics'],
    },
  };
}
