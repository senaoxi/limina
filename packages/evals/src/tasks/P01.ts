import { fileURLToPath } from 'node:url';
import type {
  TaskDefinition,
  TaskIdentities,
} from '../controller/calibration.ts';
import { dependencyInputsIdentity } from '../core/mutation.ts';
import type { Snapshot } from '../core/snapshot.ts';
import type { TaskSpec } from '../core/task.ts';
import { gradePackageExports } from '../graders/P01.ts';

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const manifest = {
  name: 'eval-exports-lib',
  version: '1.0.0',
  private: true,
  type: 'module',
  scripts: { build: 'node build.mjs' },
  exports: { '.': { types: './index.d.ts', import: './index.js' } },
  devDependencies: { limina: '0.5.0-beta.2', typescript: '6.0.3' },
};
export const packageExportsFiles: Record<string, string> = {
  'package.json': json(manifest),
  'dist/package.json': json({
    name: manifest.name,
    version: manifest.version,
    type: manifest.type,
    exports: manifest.exports,
  }),
  'dist/lib/index.js':
    'export function add(left, right) { return left + right; }\n',
  'dist/lib/index.d.ts':
    'export declare function add(left: number, right: number): number;\n',
  'src/index.ts':
    'export function add(left: number, right: number): number { return left + right; }\n',
  'tsconfig.json': json({
    compilerOptions: {
      target: 'ES2023',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      declaration: true,
      rootDir: 'src',
      outDir: 'dist/lib',
      types: [],
    },
    include: ['src/**/*.ts'],
  }),
  'build.mjs': String.raw`import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
fs.rmSync('dist', { recursive: true, force: true });
const compiled = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--pretty', 'false'], { stdio: 'inherit' });
if (compiled.status !== 0) process.exit(compiled.status ?? 1);
const { name, version, type, exports } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
fs.writeFileSync('dist/package.json', JSON.stringify({ name, version, type, exports }, null, 2) + '\n');
`,
  'limina.config.mts':
    "export default { package: { entries: [{ name: 'eval-exports-lib', outDir: 'dist', checks: ['boundary'] }] } };\n",
};
export function packageExportsTask(
  fixture: Snapshot,
  identities: TaskIdentities,
): TaskSpec {
  if (
    fixture.status !== 'complete' ||
    fixture.stage !== 'F0' ||
    !fixture.digest
  )
    throw new Error('Package task requires a complete fixture');
  const inputs: TaskSpec['dependencyPolicy']['inputs'] = [
    { path: 'package.json', format: 'manifest' },
    { path: 'dist/package.json', format: 'manifest' },
  ];
  return {
    version: 2,
    id: 'P01',
    domain: 'package-release',
    split: 'dev',
    prompt:
      'Repair the public exports of this Limina-governed library so a fresh build produces an ESM package that a separate Node and TypeScript consumer can import by package name. The existing build emits dist/lib/index.js and its declaration and copies the source manifest exports into dist/package.json. Fix the generation input rather than hand-patching dist. Keep explicit types and import conditions for the root export, pointing to real built files. Preserve the source API, build generator, compiler configuration and Limina package checks. The only persistent source change allowed is package.json exports; you may regenerate dist. Deliver the regenerated dist tree matching a fresh build; preserve its dependency-free manifest. Dependencies are already installed; do not install packages, change dependencies, replace tools, or use background jobs or subagents.',
    fixtureDigest: fixture.digest,
    capturePolicy: {
      excludedRoots: ['.eval-tmp', '.limina', 'node_modules'],
      requiredRoots: ['dist'],
    },
    mutationPolicy: {
      protectedRoots: [
        'src',
        'tsconfig.json',
        'build.mjs',
        'limina.config.mts',
      ],
      rules: [
        {
          path: 'package.json',
          operations: ['modify'],
          jsonFields: ['/exports'],
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
        'fresh-build',
        'submitted-output-matches-build',
        'package-boundary-check',
        'built-export-targets',
        'runtime-consumption',
        'type-consumption',
        'type-error-detected',
      ],
    },
  };
}
const fixedExports = {
  '.': { types: './lib/index.d.ts', import: './lib/index.js' },
};
export const packageExportsDefinition: TaskDefinition = {
  id: 'P01',
  files: packageExportsFiles,
  sourceFiles: [fileURLToPath(import.meta.url)],
  graderFiles: [fileURLToPath(new URL('../graders/P01.ts', import.meta.url))],
  createTask: packageExportsTask,
  grade: gradePackageExports,
  cases: [
    {
      id: 'reference-with-output',
      expected: 'passed',
      edits: [
        {
          path: 'package.json',
          content: json({ ...manifest, exports: fixedExports }),
        },
        {
          path: 'dist/package.json',
          content: json({
            name: manifest.name,
            version: manifest.version,
            type: manifest.type,
            exports: fixedExports,
          }),
        },
        {
          path: 'dist/lib/index.js',
          content:
            'export function add(left, right) { return left + right; }\n',
        },
        {
          path: 'dist/lib/index.d.ts',
          content:
            'export declare function add(left: number, right: number): number;\n',
        },
      ],
    },
    {
      id: 'correct-input-stale-output',
      expected: 'failed',
      edits: [
        {
          path: 'package.json',
          content: json({ ...manifest, exports: fixedExports }),
        },
        {
          path: 'dist/lib/index.js',
          content: 'throw new Error("Untrusted output must not execute");\n',
        },
      ],
    },
    {
      id: 'input-only-without-rebuild',
      expected: 'failed',
      edits: [
        {
          path: 'package.json',
          content: json({ ...manifest, exports: fixedExports }),
        },
      ],
    },
    { id: 'unchanged-missing-targets', expected: 'failed', edits: [] },
    {
      id: 'runtime-only-fix',
      expected: 'failed',
      edits: [
        {
          path: 'package.json',
          content: json({
            ...manifest,
            exports: {
              '.': { types: './index.d.ts', import: './lib/index.js' },
            },
          }),
        },
      ],
    },
    {
      id: 'types-only-fix',
      expected: 'failed',
      edits: [
        {
          path: 'package.json',
          content: json({
            ...manifest,
            exports: {
              '.': { types: './lib/index.d.ts', import: './index.js' },
            },
          }),
        },
      ],
    },
    {
      id: 'replace-build-script',
      expected: 'unsafe',
      edits: [{ path: 'build.mjs', content: 'process.exit(0);\n' }],
    },
    {
      id: 'hand-edit-output',
      expected: 'failed',
      edits: [
        {
          path: 'dist/package.json',
          content: json({
            name: manifest.name,
            version: manifest.version,
            type: manifest.type,
            exports: fixedExports,
          }),
        },
      ],
    },
  ],
};
