import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LiminaPreflightManager } from '../preflight/manager';
import { executeCheckerBuildTargets } from '../typecheck/checker/build-execution';
import { createCheckerTarget, createDefaultRunner } from '../typecheck/targets';
import { prepareAndMaterializeGeneratedTsconfigGraph } from './helpers/generated-graph';
import { withFixtureGovernanceRoot } from './helpers/governance-root';
import { createSemanticRepairFixture } from './helpers/semantic-repair';

const require = createRequire(import.meta.url);
const nativeRoot = path.dirname(
  require.resolve('@typescript/native-preview/package.json'),
);
const options = {
  composite: true,
  module: 'ESNext',
  moduleResolution: 'Bundler',
  target: 'ES2022',
  types: [],
  lib: ['es5'],
};
type Variant =
  | 'path'
  | 'nodenext'
  | 'library'
  | 'source-lib'
  | 'declaration'
  | 'noResolve'
  | 'root'
  | 'ordinary'
  | 'similar';

async function createFixture(
  variant: Variant,
  checker = 'tsgo',
  isExplicit = false,
) {
  const isLibrary = variant === 'library' || variant === 'source-lib';
  const fixture = await createSemanticRepairFixture({
    'package.json': JSON.stringify({
      name: 'external-input-workspace',
      private: true,
    }),
    'pnpm-workspace.yaml': 'packages:\n  - a\n  - b\n  - c\n',
    'limina.config.mjs': 'export default {};',
    'a/package.json': JSON.stringify({ name: '@example/a', private: true }),
    'b/package.json': JSON.stringify({ name: '@example/b', private: true }),
    'c/package.json': JSON.stringify({ name: '@example/c', private: true }),
    'c/tsconfig.json': JSON.stringify({
      compilerOptions: options,
      files: ['index.ts'],
    }),
    'c/index.ts': 'export const independent = 1;',
    'a/tsconfig.json': JSON.stringify({
      compilerOptions: {
        ...options,
        ...(isLibrary && { libReplacement: true }),
        ...(variant === 'source-lib' && { lib: [] }),
        ...(variant === 'noResolve' && { noResolve: true }),
        ...(variant === 'nodenext' && {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
        }),
      },
      files: ['index.ts', ...(variant === 'root' ? ['local.ts'] : [])],
      ...(isExplicit && {
        liminaOptions: {
          implicitRefs: [
            {
              path: '../b/tsconfig.json',
              reason: 'External input implementation prerequisite',
            },
          ],
        },
      }),
    }),
    'a/index.ts': isLibrary
      ? `${variant === 'source-lib' ? '/// <reference lib="es5" />\n' : ''}export const result: LibraryValue = {n:1};`
      : `import { value } from "../${variant === 'ordinary' ? '' : variant === 'similar' ? 'not_node_modules/../' : 'node_modules/../'}${variant === 'root' ? 'a/local' : variant === 'declaration' ? 'b/types' : 'b/index'}${variant === 'nodenext' ? '.js' : ''}"; export const result = value;`,
    'a/local.ts': 'export const value = 1;',
    'b/tsconfig.json': JSON.stringify({
      compilerOptions: options,
      files: ['index.ts'],
    }),
    'b/index.ts':
      'export const value = 1; export interface Value { n: number }',
    'b/types.d.ts': 'export declare const value: number;',
  });
  await mkdir(fixture.path('node_modules/@typescript'), { recursive: true });
  await symlink(
    nativeRoot,
    fixture.path('node_modules/@typescript/native-preview'),
    'junction',
  );
  if (isLibrary) {
    const directory = fixture.path('a/node_modules/@typescript/lib-es5');
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'package.json'),
      JSON.stringify({
        name: '@typescript/lib-es5',
        version: '1.0.0',
        types: 'index.d.ts',
      }),
    );
    const libraryPath = path
      .relative(directory, require.resolve('typescript/lib/lib.es5.d.ts'))
      .split(path.sep)
      .join('/');
    await writeFile(
      path.join(directory, 'index.d.ts'),
      `/// <reference path="${libraryPath}" />\nimport type { Value } from '../../../../b/index'; declare global { interface LibraryValue extends Value {} }`,
    );
  }
  return {
    ...fixture,
    config: withFixtureGovernanceRoot({
      rootDir: fixture.root,
      configPath: fixture.path('limina.config.mjs'),
      cache: false,
      scope: {
        checkers: {
          [checker]: {
            include: ['a/tsconfig.json', 'b/tsconfig.json', 'c/tsconfig.json'],
          },
        },
      },
    }),
  };
}

function build(root: string, entry: string, checker = 'tsgo') {
  const result = spawnSync(
    process.execPath,
    [
      checker === 'tsgo'
        ? path.join(nativeRoot, 'bin/tsgo')
        : require.resolve('typescript/bin/tsc'),
      '-b',
      entry,
      '--force',
      '--pretty',
      'false',
    ],
    { cwd: root, encoding: 'utf8', timeout: 15_000 },
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
}

async function addNormalDependency(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  mode = 'Bundler',
  hasJavaScriptInput = false,
) {
  await mkdir(fixture.path('node_modules/external'), { recursive: true });
  await writeFile(
    fixture.path('node_modules/external/package.json'),
    JSON.stringify({
      name: 'external',
      version: '1.0.0',
      types: 'index.d.cts',
    }),
  );
  await writeFile(
    fixture.path('node_modules/external/index.d.cts'),
    'export type { Value } from "./types.cts";',
  );
  await writeFile(
    fixture.path('node_modules/external/types.cts'),
    `${hasJavaScriptInput ? 'import "../../b/extra.js";' : ''} export interface Value { n: number }`,
  );
  await writeFile(
    fixture.path('a/index.ts'),
    'import type { Value } from "external"; export const result: Value = { n: 1 };',
  );
  await writeFile(
    fixture.path('a/tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        ...options,
        moduleResolution: mode,
        module: mode === 'NodeNext' ? 'NodeNext' : 'ESNext',
        ...(hasJavaScriptInput && { allowJs: true, maxNodeModuleJsDepth: 0 }),
      },
      files: ['index.ts'],
    }),
  );
  if (hasJavaScriptInput)
    await writeFile(fixture.path('b/extra.js'), 'export const extra = 1;');
}

async function createCacheCheckerFixture(isCompatible: boolean) {
  const fixture = await createFixture('path');
  try {
    if (isCompatible) await addNormalDependency(fixture);
    await writeFile(
      fixture.path('package.json'),
      JSON.stringify({
        name: 'fixture',
        private: true,
        packageManager: 'pnpm@12.10.1',
      }),
    );
    await writeFile(
      fixture.path('pnpm-lock.yaml'),
      "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  a: {}\n  b: {}\n  c: {}\n",
    );
    await writeFile(
      fixture.path('limina.config.mjs'),
      'export default {scope:{checkers:{tsgo:{include:["a/tsconfig.json","b/tsconfig.json","c/tsconfig.json"]}}}};',
    );
    const url = (name: string) =>
      new URL(`../${name}.ts`, import.meta.url).href;
    const runner = fixture.path('cache-runner.mjs');
    await writeFile(
      runner,
      `
import {loadConfig} from ${JSON.stringify(url('config/loader'))};
import {LiminaPreflightManager} from ${JSON.stringify(url('preflight/manager'))};
import {ExecutionAdmission} from ${JSON.stringify(url('typecheck/admission/execution-admission'))};
import {executeAuthorizedTypecheck} from ${JSON.stringify(url('typecheck/checker/typecheck-execution'))};
import {createCheckerTarget,createDefaultRunner} from ${JSON.stringify(url('typecheck/targets'))};
const config=await loadConfig({configPath:${JSON.stringify(fixture.path('limina.config.mjs'))}});
const events=[];
const preflight=new LiminaPreflightManager({config,analysisCache:true,metrics:{record:e=>events.push(e)}});
try {
  const graph=(await preflight.ensureGeneratedArtifactsMaterialized()).graph;
  const checker=graph.checkers.find(c=>c.name==='tsgo');
  const source=${JSON.stringify(fixture.path('a/tsconfig.json'))};
  const target=createCheckerTarget({checker,configPath:graph.sourceToBuild.get('tsgo').get(source).path,executionKind:'build',projectRootDir:config.rootDir,sourceConfigPath:source});
  const admission=new ExecutionAdmission(preflight,graph,[target]);
  let launches=0;
  const outcome=await executeAuthorizedTypecheck({admission: admission},target,(target,options)=>{launches++;return createDefaultRunner({stdio:'ignore'})(target,options);});
  const memoryHit=await preflight.ensureGeneratedGraph()===graph;
  await preflight.publishAnalysisCache();
  console.log(JSON.stringify({events,outcome,launches,memoryHit}));
} finally {preflight.dispose();}
`,
    );
    const loader = pathToFileURL(require.resolve('tsx')).href;
    return {
      ...fixture,
      run() {
        const output = execFileSync(
          process.execPath,
          ['--import', loader, runner],
          {
            encoding: 'utf8',
            timeout: 20_000,
          },
        );
        return JSON.parse(output.trim()) as {
          events: { kind: string; count?: number }[];
          launches: number;
          memoryHit: boolean;
          outcome: { status: number | 'admission-rejected' };
        };
      },
    };
  } catch (error) {
    await fixture.cleanup();
    throw error;
  }
}

async function replaceFixtureNativePackage(
  fixture: Awaited<ReturnType<typeof createCacheCheckerFixture>>,
  { hasNativeApi = true }: { hasNativeApi?: boolean } = {},
): Promise<string> {
  const alternate = fixture.path('.toolchain/native');
  await cp(nativeRoot, alternate, { recursive: true, dereference: true });
  const manifestPath = path.join(alternate, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.version = '7.0.0-dev.99999999.1';
  if (!hasNativeApi) delete manifest.exports['./unstable/sync'];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const platform = `@typescript/native-preview-${process.platform}-${process.arch}`;
  const nativeRequire = createRequire(path.join(nativeRoot, 'package.json'));
  const platformManifest = nativeRequire.resolve(`${platform}/package.json`);
  await symlink(
    path.dirname(platformManifest),
    fixture.path('node_modules', platform),
    'junction',
  );
  await rm(fixture.path('node_modules/@typescript/native-preview'));
  await symlink(
    alternate,
    fixture.path('node_modules/@typescript/native-preview'),
    'junction',
  );
  return alternate;
}

async function managedBuild(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  checkerName = 'tsgo',
  selected = ['a', 'c'],
  isOutputBuild = false,
) {
  const preflight = new LiminaPreflightManager({ config: fixture.config });
  try {
    const graph = (await preflight.ensureGeneratedArtifactsMaterialized())
      .graph;
    const before = JSON.stringify(graph.dependencyAnalysis);
    const checker = graph.checkers.find((item) => item.name === checkerName)!;
    const targets = selected.map((name) =>
      createCheckerTarget({
        checker,
        configPath: isOutputBuild
          ? graph.configToOutputBuild
              .get(checkerName)!
              .get(fixture.path(name, 'tsconfig.json'))!.path
          : graph.sourceToBuild
              .get(checkerName)!
              .get(fixture.path(name, 'tsconfig.json'))!.path,
        executionKind: 'build',
        projectRootDir: fixture.root,
        sourceConfigPath: fixture.path(name, 'tsconfig.json'),
      }),
    );
    const started: string[] = [];
    const run = createDefaultRunner({ stdio: 'ignore' });
    const result = await executeCheckerBuildTargets({
      allCheckers: graph.checkers,
      config: fixture.config,
      flowDepth: 0,
      generatedGraph: graph,
      label: 'external-library compatibility',
      preflight,
      projectRootDir: fixture.root,
      targets,
      watch: undefined,
      workspaceContext: await preflight.ensureWorkspaceValidated(),
      runnerOptions: {
        config: fixture.config,
        report: { defer: true },
        runner: (target, options) => {
          started.push(target.sourceConfigPath!);
          return run(target, options);
        },
      },
    });
    expect(JSON.stringify(graph.dependencyAnalysis)).toBe(before);
    return { graph, result, started };
  } finally {
    preflight.dispose();
  }
}

describe('external-library semantic authority and Checker execution', () => {
  it('retains the host Reference Graph independently of tsgo execution', async () => {
    const fixture = await createFixture('path');
    try {
      const graph = await prepareAndMaterializeGeneratedTsconfigGraph(
        fixture.config,
      );
      expect(graph.dependencyEdges).toEqual([]);
      expect(graph.sourceToDts.get('tsgo')?.size).toBe(3);
    } finally {
      await fixture.cleanup();
    }
  });
  it('executes ordinary implementation consumption inside node_modules', async () => {
    const fixture = await createFixture('path');
    try {
      await mkdir(fixture.path('node_modules/external'), { recursive: true });
      await writeFile(
        fixture.path('node_modules/external/index.ts'),
        'export const value = 1;',
      );
      await writeFile(
        fixture.path('a/index.ts'),
        'import {value} from "../node_modules/external/index"; export const result = value;',
      );
      const { graph, result, started } = await managedBuild(fixture);
      expect(graph.dependencyEdges).toEqual([]);
      expect(started).toHaveLength(2);
      expect(result.passed).toBe(true);
      expect(result.failedTargets).toEqual([]);
      build(fixture.root, graph.checkerEntries.get('tsgo')!);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(['Bundler', 'NodeNext'])(
    'executes declaration-to-implementation imports without a Native observer: %s',
    async (mode) => {
      const fixture = await createFixture('path');
      try {
        await addNormalDependency(fixture, mode);
        const { result, started } = await managedBuild(fixture);
        expect(started).toHaveLength(2);
        expect(result.passed).toBe(true);
        expect(result.failedTargets).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it('delegates downstream JavaScript loading differences to tsgo', async () => {
    const fixture = await createFixture('path');
    try {
      await addNormalDependency(fixture, 'Bundler', true);
      const { result, started } = await managedBuild(fixture);
      expect(started).toHaveLength(2);
      expect(
        result.targetOutcomes.every(
          (item) => item.status !== 'admission-rejected',
        ),
      ).toBe(true);
      expect(result.passed).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('executes referenced projects without requiring Native API redirection proof', async () => {
    const fixture = await createFixture('path');
    try {
      await addNormalDependency(fixture);
      const config = JSON.parse(
        await readFile(fixture.path('a/tsconfig.json'), 'utf8'),
      );
      config.liminaOptions = {
        implicitRefs: [
          { path: '../b/tsconfig.json', reason: 'Build prerequisite' },
        ],
      };
      await writeFile(fixture.path('a/tsconfig.json'), JSON.stringify(config));
      const { graph, result, started } = await managedBuild(fixture);
      expect(started).toHaveLength(2);
      expect(result.passed).toBe(true);
      expect(graph.dependencyAnalysis?.candidate?.references).toContainEqual({
        from: fixture.path('a/tsconfig.json'),
        to: fixture.path('b/tsconfig.json'),
      });
    } finally {
      await fixture.cleanup();
    }
  });
  it('runs tsgo for an implementation introduced only by the output library', async () => {
    const fixture = await createFixture('path');
    try {
      await writeFile(fixture.path('a/index.ts'), 'export const result = 1;');
      const config = {
        compilerOptions: {
          ...options,
          target: 'ES2020',
          lib: undefined,
          libReplacement: true,
        },
        files: ['index.ts'],
        liminaOptions: { outputs: { outDir: './dist', target: 'ES2022' } },
      };
      await writeFile(fixture.path('a/tsconfig.json'), JSON.stringify(config));
      const directory = fixture.path('a/node_modules/@typescript/lib-es2022');
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, 'package.json'),
        JSON.stringify({
          name: '@typescript/lib-es2022',
          version: '1.0.0',
          types: 'index.d.ts',
        }),
      );
      const libraryPath = path
        .relative(directory, require.resolve('typescript/lib/lib.es2022.d.ts'))
        .split(path.sep)
        .join('/');
      await writeFile(
        path.join(directory, 'index.d.ts'),
        `/// <reference path="${libraryPath}" />\nimport '../../../../b/index';`,
      );
      const declarations = await managedBuild(fixture, 'tsgo', ['a']);
      expect(declarations.result.passed).toBe(true);
      const output = await managedBuild(fixture, 'tsgo', ['a'], true);
      expect(output.started).toEqual([fixture.path('a/tsconfig.json')]);
      expect(
        output.result.targetOutcomes.every(
          (item) => item.status !== 'admission-rejected',
        ),
      ).toBe(true);
      expect(output.result.passed).toBe(false);
      expect(output.result.failedTargets[0]?.exitCode).toEqual(
        expect.any(Number),
      );
      // The identical source succeeds when it has no output projection.
      await writeFile(
        fixture.path('a/tsconfig.json'),
        JSON.stringify({ ...config, liminaOptions: undefined }),
      );
      const graph = await prepareAndMaterializeGeneratedTsconfigGraph(
        fixture.config,
      );
      build(fixture.root, graph.checkerEntries.get('tsgo')!);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each<Variant>(['path', 'nodenext', 'library', 'source-lib'])(
    'reports the real tsgo failure without rewriting graph evidence: %s',
    async (variant) => {
      const fixture = await createFixture(variant);
      try {
        const { graph, result, started } = await managedBuild(fixture);
        expect(graph.dependencyEdges).toEqual([]);
        expect(started).toHaveLength(2);
        expect(result.results).toHaveLength(2);
        expect(
          result.targetOutcomes.every(
            (item) => item.status !== 'admission-rejected',
          ),
        ).toBe(true);
        expect(result.passed).toBe(false);
        expect(result.failedTargets[0]?.exitCode).toEqual(expect.any(Number));
        expect(result.failedTargets[0]?.exitCode).not.toBe(0);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each<Variant>(['path', 'library'])(
    'preserves explicit prerequisites while executing tsgo: %s',
    async (variant) => {
      const fixture = await createFixture(variant, 'tsgo', true);
      try {
        const { graph, result, started } = await managedBuild(fixture);
        expect(graph.dependencyEdges).toEqual([]);
        expect(graph.dependencyAnalysis?.candidate?.references).toContainEqual({
          from: fixture.path('a/tsconfig.json'),
          to: fixture.path('b/tsconfig.json'),
        });
        expect(started).toHaveLength(2);
        expect(result.passed).toBe(true);
        build(fixture.root, graph.checkerEntries.get('tsgo')!);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each([true, false])(
    'preserves host implicit JSX evidence during tsgo execution (escaping: %s)',
    async (isEscaping) => {
      const fixture = await createFixture('path');
      try {
        await writeFile(
          fixture.path('a/tsconfig.json'),
          JSON.stringify({
            compilerOptions: {
              ...options,
              jsx: 'react-jsx',
              jsxImportSource: isEscaping ? '../node_modules/../b' : '../b',
            },
            files: ['index.tsx'],
          }),
        );
        await writeFile(
          fixture.path('a/index.tsx'),
          'export const element = <div/>;',
        );
        await writeFile(
          fixture.path('b/jsx-runtime.ts'),
          'export namespace JSX { export interface IntrinsicElements { div: {} } } export function jsx() { return 1; } export const jsxs = jsx;',
        );
        await writeFile(
          fixture.path('b/tsconfig.json'),
          JSON.stringify({
            compilerOptions: options,
            files: ['index.ts', 'jsx-runtime.ts'],
          }),
        );
        const { result, started } = await managedBuild(fixture);
        expect(started).toHaveLength(2);
        expect(
          result.targetOutcomes.every(
            (item) => item.status !== 'admission-rejected',
          ),
        ).toBe(true);
        expect(result.passed).toBe(!isEscaping);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each([true, false])(
    'preserves inherited host external status through a declaration (escaping: %s)',
    async (isEscaping) => {
      const fixture = await createFixture('path');
      try {
        const prefix = isEscaping ? '../node_modules/../b' : '../b';
        await writeFile(
          fixture.path('a/index.ts'),
          `import type {Value} from "${prefix}/types"; export const result: Value = {n:1};`,
        );
        await writeFile(
          fixture.path('b/types.d.ts'),
          'export type {Value} from "./index";',
        );
        const { result, started } = await managedBuild(fixture);
        expect(started).toHaveLength(2);
        expect(
          result.targetOutcomes.every(
            (item) => item.status !== 'admission-rejected',
          ),
        ).toBe(true);
        expect(result.passed).toBe(!isEscaping);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it('retains TypeScript external-library semantics', async () => {
    const fixture = await createFixture('path', 'tsc');
    try {
      const { graph, result, started } = await managedBuild(fixture, 'tsc');
      expect(graph.dependencyEdges).toEqual([]);
      expect(result.passed).toBe(true);
      expect(started).toHaveLength(2);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each<Variant>(['declaration', 'root', 'noResolve', 'ordinary', 'similar'])(
    'preserves independent absence evidence: %s',
    async (variant) => {
      const fixture = await createFixture(variant);
      try {
        const { result, started } = await managedBuild(fixture);
        expect(started).toHaveLength(2);
        expect(
          result.targetOutcomes.every(
            (outcome) => outcome.status !== 'admission-rejected',
          ),
        ).toBe(true);
        expect(result.passed).toBe(variant !== 'noResolve');
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it('executes the actual reference closure and reports its Checker failure', async () => {
    const fixture = await createFixture('path');
    try {
      await writeFile(
        fixture.path('b/tsconfig.json'),
        JSON.stringify({
          compilerOptions: options,
          files: ['index.ts'],
          liminaOptions: {
            implicitRefs: [
              { path: '../a/tsconfig.json', reason: 'Build prerequisite' },
            ],
          },
        }),
      );
      const { graph, result, started } = await managedBuild(fixture, 'tsgo', [
        'b',
        'c',
      ]);
      expect(graph.dependencyAnalysis?.candidate?.references).toContainEqual({
        from: fixture.path('b/tsconfig.json'),
        to: fixture.path('a/tsconfig.json'),
      });
      expect(started).toHaveLength(2);
      expect(
        result.targetOutcomes.every(
          (item) => item.status !== 'admission-rejected',
        ),
      ).toBe(true);
      expect(result.passed).toBe(false);
      expect(result.failedTargets[0]?.exitCode).not.toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([false, true])(
    'restores host facts and invalidates them after the tsgo executor changes (succeeds: %s)',
    async (isCompatible) => {
      const fixture = await createCacheCheckerFixture(isCompatible);
      try {
        const cold = fixture.run();
        const restored = fixture.run();
        expect(cold.events).toContainEqual(
          expect.objectContaining({ kind: 'graphBuilds', count: 1 }),
        );
        expect(restored.events).toContainEqual(
          expect.objectContaining({ kind: 'graphHits', count: 1 }),
        );
        // Change only a fixture-owned tool identity; do not mutate the shared installation.
        await replaceFixtureNativePackage(fixture);
        const changed = fixture.run();
        expect(
          changed.events
            .filter((event) => event.kind === 'graphHits')
            .reduce((sum, event) => sum + (event.count ?? 0), 0),
        ).toBe(0);
        expect(changed.events).toContainEqual(
          expect.objectContaining({ kind: 'graphBuilds', count: 1 }),
        );
        for (const result of [cold, restored, changed]) {
          expect(result.launches).toBe(1);
          expect(result.memoryHit).toBe(true);
          expect(result.outcome.status).toEqual(expect.any(Number));
          if (isCompatible) expect(result.outcome.status).toBe(0);
          else expect(result.outcome.status).not.toBe(0);
        }
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it('restores host facts without the Native API when an unused observer changes', async () => {
    const fixture = await createCacheCheckerFixture(true);
    try {
      const alternate = await replaceFixtureNativePackage(fixture, {
        hasNativeApi: false,
      });
      const cold = fixture.run();
      expect(cold.events).toContainEqual(
        expect.objectContaining({ kind: 'graphBuilds', count: 1 }),
      );
      await writeFile(
        path.join(alternate, 'dist/unused-observer.js'),
        'throw new Error("must not load observer");',
      );
      const restored = fixture.run();
      expect(restored.events).toContainEqual(
        expect.objectContaining({ kind: 'graphHits', count: 1 }),
      );
      for (const result of [cold, restored]) {
        expect(result.launches).toBe(1);
        expect(result.outcome.status).toBe(0);
      }
    } finally {
      await fixture.cleanup();
    }
  });
});
