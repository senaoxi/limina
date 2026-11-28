import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisMetricMeasurement } from '../application/analysis/analysis-run';
import type { AnalysisProfile } from '../application/analysis/observability';
import { parseTypeScriptCommandLine } from '../checker/project-base';
import {
  captureInvocationData,
  invocationDataVersion,
} from '../config/invocation-data';
import { loadConfig } from '../config/loader';
import { getActiveCheckers } from '../config/runtime';
import { createAnalysisProviders } from '../core';
import { directoryFingerprint } from '../core/analysis-cache/directory-fingerprint';
import { NativeAnalysisCache } from '../core/analysis-cache/native-cache';
import { occurrenceKey } from '../core/analysis-cache/semantic-state';
import { parseAnalysisSnapshot } from '../core/analysis-cache/snapshot-schema';
import type { CheckerOwnershipPlan } from '../core/build-graph/checker-ownership-types';
import type { GeneratedTsconfigGraphManifest } from '../core/build-graph/manifest-types';
import type { GeneratedDependencyEdge } from '../core/build-graph/types';
import { projectNativeReferenceFacts } from '../core/project-dependencies/native-reference-facts';
import { createBoundedTypeScriptSemanticContext } from '../core/typescript-semantic';
import type { TypeScriptSemanticProject } from '../core/typescript-semantic/contracts';
import { createWorkspaceSourceBoundary } from '../core/typescript-semantic/workspace-source-boundary';
import { createLiminaArtifactNamespace } from '../domain/artifacts/namespace';
import { LiminaPreflightManager } from '../preflight';
import { AnalysisCacheStore } from '../preflight/analysis-cache-store';
import {
  readStoredAnalysisSnapshot,
  writeStoredAnalysisSnapshot,
} from './helpers/analysis-snapshot';
import {
  conditionalProviders,
  conditionalReferenceFiles,
  type ConditionalReferenceMode,
  expectConditionalReferenceEdges,
} from './helpers/conditional-reference-fixture';
import { withFixtureGovernanceRoot } from './helpers/governance-root';
import { readFixtureSourceCoverage } from './helpers/native-coverage';
import { graphMeaning, nativeFactMeaning } from './helpers/native-meaning';
import {
  createFixturePathResolver,
  toPortableRelativePath,
} from './helpers/path';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const defaultFixtureFiles = {
  'package.json': JSON.stringify({
    name: 'fixture',
    private: true,
    type: 'commonjs',
    packageManager: 'npm@11.6.1',
  }),
  'package-lock.json': JSON.stringify({
    name: 'fixture',
    lockfileVersion: 3,
    packages: { '': {} },
  }),
  'limina.config.mjs':
    'export default {scope: {checkers:{tsc:{include:["tsconfig.json"]}}}};',
  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      composite: true,
      declaration: true,
      noLib: true,
      types: [],
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      outDir: 'dist',
    },
    include: ['src/**/*.ts'],
  }),
  'src/a.ts': "import type { V } from './value.js'; export type T = V;",
  'src/value.d.ts': 'export interface V { value: string }',
};

function fixture(initialFiles: Record<string, string> = defaultFixtureFiles) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'limina-full-cache-'));
  const root = realpathSync.native(temporary);
  roots.push(root);
  const file = createFixturePathResolver(root);
  const write = (name: string, content: string) => {
    mkdirSync(path.dirname(file(name)), { recursive: true });
    writeFileSync(file(name), content);
  };
  for (const [name, content] of Object.entries(initialFiles))
    write(name, content);
  const config = withFixtureGovernanceRoot({
    rootDir: root,
    configPath: file('limina.config.mjs'),
    scope: { checkers: { tsc: { include: ['tsconfig.json'] } } },
  });
  const project = (name = 'tsconfig.json'): TypeScriptSemanticProject => {
    const { parsed } = parseTypeScriptCommandLine({
      parseOptions: {
        configPath: file(name),
        projectRootDir: path.dirname(file(name)),
      },
    });
    return {
      analysisBinding: { phase: 'locked', checker: 'tsc' },
      admissionMode: 'coverage-bounded',
      configPath: file(name),
      fileNames: parsed.fileNames,
      options: parsed.options,
      projectReferences: parsed.projectReferences,
      workspaceSourceBoundary: createWorkspaceSourceBoundary(
        parsed.fileNames,
        undefined,
        readFixtureSourceCoverage([file(name)]),
      ),
    };
  };
  const execute = <T>(script: string): T => {
    const url = (name: string) =>
      new URL(`../${name}.ts`, import.meta.url).href;
    write(
      'cache-runner.mjs',
      `
import {loadConfig} from ${JSON.stringify(url('config/loader'))};
import {LiminaPreflightManager} from ${JSON.stringify(url('preflight/manager'))};
import {createPreflightGenerationController} from ${JSON.stringify(url('preflight/generation'))};
import {isRunGraphCheckImpl} from ${JSON.stringify(url('graph-check/runner'))};
import {AnalysisObserver,runWithProfile} from ${JSON.stringify(url('application/analysis/observability'))};
async function runCache(options={}) {
  const config=await loadConfig({configPath:${JSON.stringify(file('limina.config.mjs'))}});
  const events=[];
  const manager=new LiminaPreflightManager({config,analysisCache:options.cache==='read-only'?'read-only':options.cache!==false,forceAnalysisCache:options.force,metrics:{record:event=>events.push(event)}});
  try {
    if(options.materialize)await manager.ensureGeneratedArtifactsMaterialized();
    let graph=await manager.ensureGeneratedGraph();
    const isPassed=options.check ? await isRunGraphCheckImpl(config,{preflight:manager}) : true;
    if(!options.deferPublish)await manager.publishAnalysisCache();
    if(options.refresh) {
      createPreflightGenerationController(manager).startNextGeneration();
      graph=await manager.ensureGeneratedGraph();
      await manager.publishAnalysisCache();
    }
    return {graph:{manifest:graph.manifest,ownershipPlan:graph.ownershipPlan,edges:graph.dependencyEdges},events,isPassed,ambiguities:manager.getFrameworkInferenceAmbiguities()};
  }finally{manager.dispose();}
}
async function profileGraph(options) {
  const observer=new AnalysisObserver('limina graph prepare',performance.now());
  observer.setRoot(${JSON.stringify(root)});
  const result=await runWithProfile(observer,()=>runCache(options));
  observer.stop(result.isPassed);
  return {...result,profile:observer.snapshot()};
}
${script}`,
    );
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
        file('cache-runner.mjs'),
      ],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    return JSON.parse(output.trim().split('\n').at(-1)!);
  };
  return { root, file, write, config, project, execute };
}
function analyze(
  project: TypeScriptSemanticProject,
  previous?: NativeAnalysisCache,
) {
  const encoded =
    previous === undefined ? undefined : JSON.stringify(previous.snapshot());
  const snapshot =
    encoded === undefined
      ? undefined
      : parseAnalysisSnapshot(JSON.parse(encoded), 'fixture');
  if (previous !== undefined) expect(snapshot).toBeDefined();
  return analyzeWithCache(
    project,
    new NativeAnalysisCache('fixture', snapshot, 'fixture-config'),
  );
}
function analyzeWithCache(
  project: TypeScriptSemanticProject,
  cache: NativeAnalysisCache,
) {
  const restored = cache.restoreContext(project);
  const context =
    restored ??
    createBoundedTypeScriptSemanticContext(project, { analysisCache: cache });
  const facts = project.fileNames.flatMap((file) =>
    context
      .getImportRecords(file)
      .map((record) => context.getDependencyFact(record)),
  );
  if ('dispose' in context && typeof context.dispose === 'function')
    context.dispose();
  return { cache, facts, restored: restored !== undefined };
}

describe('complete native restoration and R02 scope evidence', () => {
  it.each(['unchanged', 'new source root'] as const)(
    'restores the needed context after a producer handoff (%s)',
    async (change) => {
      const f = fixture();
      f.write(
        'tsconfig.consumer.json',
        '{"files":["src/value.d.ts"],"compilerOptions":{"noLib":true,"types":[]}}',
      );
      const consumerOnly = f.project('tsconfig.consumer.json');
      const seed = analyze(f.project()).cache;
      analyzeWithCache(consumerOnly, seed);
      const options = {
        namespace: createLiminaArtifactNamespace({
          rootDir: f.root,
          generation: 0,
        }),
        configPath: f.config.configPath,
        identity: 'fixture',
        configVersion: 'fixture-config',
      };
      const writer = new AnalysisCacheStore(options);
      await writer.publish(seed);
      const prior = parseAnalysisSnapshot(
        readStoredAnalysisSnapshot(writer.path),
        'fixture',
      );
      expect(prior).toBeDefined();
      if (change === 'new source root')
        f.write('src/added.ts', "export type { V } from './value.js';");
      const project = f.project();
      const producer = new NativeAnalysisCache(
        'fixture',
        prior,
        'fixture-config',
      );
      expect(analyzeWithCache(project, producer).restored).toBe(
        change === 'unchanged',
      );
      const candidate = new AnalysisCacheStore(options).refresh(
        producer,
        'producer-handoff',
      );
      const consumer = new NativeAnalysisCache(
        'fixture',
        candidate,
        'fixture-config',
      );
      if (change === 'unchanged') {
        expect(
          consumer
            .restoreContext(consumerOnly)
            ?.hasSourceFile(f.file('src/value.d.ts')),
        ).toBe(true);
      } else {
        const source = f.file('src/added.ts');
        const restored = consumer.restoreContext(project);
        expect(restored?.hasSourceFile(source)).toBe(true);
        const [request] = restored!.getImportRecords(source);
        expect(
          restored!.resolveImportRecord(request!).target?.resolvedFileName,
        ).toBe(f.file('src/value.d.ts'));
      }
    },
  );

  it('selects current config-only ownership without creating a selection Program', async () => {
    const f = fixture();
    f.write('limina.config.mjs', 'export default {};');
    const config = await loadConfig({
      configPath: f.file('limina.config.mjs'),
    });
    const store = new AnalysisCacheStore({
      namespace: createLiminaArtifactNamespace({
        rootDir: f.root,
        generation: 0,
      }),
      configPath: config.configPath,
      identity: 'fixture',
      configVersion: 'fixture-config',
    });
    const coldCache = new NativeAnalysisCache(
      'fixture',
      store.read(),
      'fixture-config',
    );
    const cold = createAnalysisProviders(config, undefined, undefined, {
      analysisCache: coldCache,
    });
    try {
      await cold.buildGraph.getGraph();
      await store.publish(coldCache);
    } finally {
      cold.dispose();
    }
    const snapshot = parseAnalysisSnapshot(
      readStoredAnalysisSnapshot(store.path),
      'fixture',
    );
    expect(snapshot).toBeDefined();
    const cache = new NativeAnalysisCache(
      'fixture',
      snapshot,
      'fixture-config',
    );
    const events: AnalysisMetricMeasurement[] = [];
    const warm = createAnalysisProviders(
      config,
      undefined,
      {
        record: (event) => {
          events.push(event);
        },
      },
      { analysisCache: cache },
    );
    try {
      expect(await warm.buildGraph.hasSvelteCheckProjects()).toBe(false);
      expect(cache.metrics.ownershipResolutions).toBe(1);
      expect(cache.metrics.restoredContexts).toBeGreaterThan(0);
      expect(cache.metrics.semanticPrograms).toBe(0);
      expect(
        events
          .filter((event) => event.name === 'bounded-program-create')
          .reduce((count, event) => count + (event.count ?? 0), 0),
      ).toBe(0);
    } finally {
      warm.dispose();
    }
  });

  it('preserves native customConditions through restoration and invalidates changed conditions', () => {
    const f = fixture();
    f.write(
      'package.json',
      JSON.stringify({
        name: 'fixture',
        private: true,
        type: 'module',
        exports: {
          '.': {
            browser: './src/browser.d.ts',
            default: './src/default.d.ts',
          },
        },
      }),
    );
    f.write('src/a.ts', "import { value } from 'fixture'; export { value };");
    f.write('src/browser.d.ts', 'export declare const value: "browser";');
    f.write('src/default.d.ts', 'export declare const value: "default";');
    const sourceConfig = JSON.parse(
      readFileSync(f.file('tsconfig.json'), 'utf8'),
    );
    const setConditions = (conditions: string[]) => {
      f.write(
        'tsconfig.json',
        JSON.stringify({
          ...sourceConfig,
          compilerOptions: {
            ...sourceConfig.compilerOptions,
            customConditions: conditions,
          },
        }),
      );
    };
    setConditions(['browser']);
    const first = analyze(f.project());
    expect(first.facts[0]?.resolution.target?.resolvedFileName).toBe(
      f.file('src/browser.d.ts'),
    );
    const warm = analyze(f.project(), first.cache);
    expect(warm.restored).toBe(true);
    expect(warm.cache.metrics.semanticPrograms).toBe(0);
    expect(warm.facts).toEqual(first.facts);

    setConditions(['server']);
    const changed = analyze(f.project(), warm.cache);
    expect(changed.restored).toBe(false);
    expect(changed.cache.metrics.semanticPrograms).toBeGreaterThan(0);
    expect(changed.facts[0]?.resolution.target?.resolvedFileName).toBe(
      f.file('src/default.d.ts'),
    );
    const restored = analyze(f.project(), changed.cache);
    expect(restored.restored).toBe(true);
    expect(restored.cache.metrics.semanticPrograms).toBe(0);
    expect(restored.facts).toEqual(changed.facts);
  });

  it.each([ts.ModuleKind.NodeNext, ts.ModuleKind.Node16])(
    'restores normal mode %s before Program and invalidates a nearer scope even with an identical target',
    (module) => {
      const f = fixture();
      const project = {
        ...f.project(),
        options: {
          ...f.project().options,
          module,
          moduleResolution:
            module === ts.ModuleKind.Node16
              ? ts.ModuleResolutionKind.Node16
              : ts.ModuleResolutionKind.NodeNext,
        },
      };
      const first = analyze(project);
      const clean = analyze(project, first.cache);
      expect(clean.restored).toBe(true);
      expect(clean.cache.metrics.semanticPrograms).toBe(0);
      expect(clean.facts).toEqual(first.facts);
      f.write('src/package.json', '{"type":"module"}');
      const dirty = analyze(project, clean.cache);
      expect(dirty.restored).toBe(false);
      expect(dirty.facts[0]?.resolution.target).toEqual(
        first.facts[0]?.resolution.target,
      );
      expect(dirty.facts[0]?.resolution.resolutionMode).not.toBe(
        first.facts[0]?.resolution.resolutionMode,
      );
      expect(dirty.facts.map(nativeFactMeaning)).toEqual(
        analyze(project).facts.map(nativeFactMeaning),
      );
      rmSync(f.file('src/package.json'));
      expect(
        analyze(project, dirty.cache).facts.map(nativeFactMeaning),
      ).toEqual(first.facts.map(nativeFactMeaning));
    },
  );

  it('invalidates scope rebinding with identical content and timestamps', () => {
    const f = fixture();
    f.write('one.json', '{"type":"module"}');
    f.write('two.json', '{"type":"module"}');
    const same = Math.floor(statSync(f.file('one.json')).mtimeMs / 1000);
    utimesSync(f.file('one.json'), same, same);
    utimesSync(f.file('two.json'), same, same);
    symlinkSync(f.file('one.json'), f.file('src/package.json'));
    const first = analyze(f.project());
    expect(analyze(f.project(), first.cache).restored).toBe(true);
    rmSync(f.file('src/package.json'));
    symlinkSync(f.file('two.json'), f.file('src/package.json'));
    const next = analyze(f.project(), first.cache);
    expect(next.restored).toBe(false);
    expect(next.cache.metrics.semanticPrograms).toBe(1);
    expect(next.facts[0]?.nativeEvidence?.origin.context.id).not.toBe(
      first.facts[0]?.nativeEvidence?.origin.context.id,
    );
  });
});

describe('physical type environments', () => {
  it.each([false, true])(
    'restores a shared pnpm member without scanning installed roots (explicit roots: %s)',
    (explicitRoots) => {
      const f = fixture();
      const pnpmVersion = '12.10.1';
      f.write(
        'package.json',
        JSON.stringify({
          private: true,
          packageManager: `pnpm@${pnpmVersion}`,
        }),
      );
      rmSync(f.file('package-lock.json'));
      f.write('pnpm-workspace.yaml', 'packages: [packages/*]\n');
      f.write('pnpm-lock.yaml', 'opaque lock identity');
      f.write(
        'node_modules/.modules.yaml',
        `packageManager: pnpm@${pnpmVersion}\nvirtualStoreDir: .pnpm\n`,
      );
      f.write(
        'node_modules/.pnpm/types/node_modules/@types/pkg/index.d.ts',
        'declare const installed: string;',
      );
      f.write(
        'packages/member/package.json',
        '{"name":"member","private":true}',
      );
      f.write(
        'packages/member/src/a.ts',
        "import type { V } from '../../../src/value.js'; export type T = V;",
      );
      mkdirSync(f.file('packages/member/node_modules/@types'), {
        recursive: true,
      });
      symlinkSync(
        f.file('node_modules/.pnpm/types/node_modules/@types/pkg'),
        f.file('packages/member/node_modules/@types/pkg'),
        'junction',
      );
      f.write(
        'packages/member/tsconfig.json',
        JSON.stringify({
          compilerOptions: {
            noLib: true,
            types: ['pkg'],
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            ...(explicitRoots && {
              typeRoots: ['./node_modules/@types', '../../node_modules'],
            }),
          },
          include: ['src/**/*.ts'],
        }),
      );
      const first = analyze(f.project('packages/member/tsconfig.json'));
      const warm = analyze(
        f.project('packages/member/tsconfig.json'),
        first.cache,
      );
      expect(warm.restored).toBe(true);
      expect(warm.cache.metrics.semanticPrograms).toBe(0);
      expect(warm.cache.metrics.localRootScans ?? 0).toBe(0);
      expect(warm.facts).toEqual(first.facts);
      f.write(
        'node_modules/.pnpm/types/node_modules/@types/pkg/package.json',
        '{"name":"@types/pkg","version":"2.0.0"}',
      );
      const changed = analyze(
        f.project('packages/member/tsconfig.json'),
        warm.cache,
      );
      expect(changed.restored).toBe(false);
      expect(
        analyze(f.project('packages/member/tsconfig.json'), changed.cache)
          .restored,
      ).toBe(true);
    },
  );

  it('observes inherited paths, backdated additions, renames, touches and missing versus empty', () => {
    const f = fixture();
    f.write(
      'base/tsconfig.json',
      '{"compilerOptions":{"typeRoots":["../types","../missing"]}}',
    );
    f.write(
      'tsconfig.json',
      '{"extends":"./base/tsconfig.json","compilerOptions":{"noLib":true,"module":"NodeNext","moduleResolution":"NodeNext"},"include":["src/**/*.ts"]}',
    );
    f.write('types/pkg/index.d.ts', 'declare module "global-test" {}');
    const first = analyze(f.project());
    expect(
      Object.values(first.cache.contexts)[0]?.environment.effectiveTypeRoots,
    ).toEqual([f.file('types'), f.file('missing')]);
    expect(analyze(f.project(), first.cache).restored).toBe(true);
    f.write('types/unconsumed.txt', 'unconsumed');
    utimesSync(f.file('types/unconsumed.txt'), 1, 1);
    const added = analyze(f.project(), first.cache);
    expect(added.restored).toBe(false);
    renameSync(f.file('types/unconsumed.txt'), f.file('types/renamed.txt'));
    const renamed = analyze(f.project(), added.cache);
    expect(renamed.restored).toBe(false);
    utimesSync(f.file('types/renamed.txt'), 2, 2);
    const touched = analyze(f.project(), renamed.cache);
    expect(touched.restored).toBe(false);
    mkdirSync(f.file('missing'));
    expect(analyze(f.project(), touched.cache).restored).toBe(false);
  });

  it('scans structure and rejects failures while preserving the declared metadata blindspot', () => {
    const f = fixture();
    f.write('types/pkg/a.d.ts', 'old');
    const file = f.file('types/pkg/a.d.ts');
    const before = Math.floor(statSync(file).mtimeMs / 1000);
    utimesSync(file, before, before);
    const hash = directoryFingerprint(f.file('types'));
    writeFileSync(file, 'new');
    utimesSync(file, before, before);
    expect(directoryFingerprint(f.file('types'))).toBe(hash);
    renameSync(file, f.file('types/pkg/b.d.ts'));
    expect(directoryFingerprint(f.file('types'))).not.toBe(hash);
    symlinkSync(f.file('types'), f.file('types/pkg/cycle'));
    expect(() => directoryFingerprint(f.file('types'))).toThrow('Cyclic');
  });
});

describe('R03 evaluation, own data and namespace validity', () => {
  it('reuses graph facts after reevaluating scheduling concurrency in the same configuration module', () => {
    const f = fixture();
    f.write(
      'limina.config.mjs',
      `export default {
      scope:{checkers:{tsc:{include:['tsconfig.json']}}},
      concurrency:{checkerTypecheck:Number(process.env.LIMINA_TEST_CONCURRENCY ?? 1)}
    };`,
    );
    const [first, changed] = f.execute<GraphRunResult[]>(`
      process.env.LIMINA_TEST_CONCURRENCY='1'; const first=await runCache();
      process.env.LIMINA_TEST_CONCURRENCY='2'; const changed=await runCache();
      console.log(JSON.stringify([first,changed]));`);
    expect(changed.graph).toEqual(first.graph);
    expectRestoredFacts(changed);
    expect(changed.events).toContainEqual(
      expect.objectContaining({ kind: 'semanticPrograms', count: 0 }),
    );
  });

  it('rebuilds the entire analysis model on policy changes and restores equal configuration without publishing', async () => {
    const f = fixture();
    const project = JSON.parse(readFileSync(f.file('tsconfig.json'), 'utf8'));
    f.write(
      'tsconfig.json',
      JSON.stringify({
        ...project,
        liminaOptions: { graphRules: ['runtime'] },
      }),
    );
    f.write('src/a.ts', "import fs from 'node:fs'; export const result = fs;");
    f.write(
      'limina.config.mjs',
      `export default {scope: {checkers:{tsc:{include:['tsconfig.json']}}},
graph:{rules:{runtime:process.env.LIMINA_CONFIG_DENIED === 'yes' ? {deny:{deps:[{name:'node:*',reason:'runtime policy'}]}} : {}}}};`,
    );
    const results = f.execute<GraphRunResult[]>(`
      const evaluate=async(deny,cache)=>{process.env.LIMINA_CONFIG_DENIED=deny?'yes':'no';return runCache({check:true,cache});};
      console.log(JSON.stringify([await evaluate(false,true),await evaluate(true,true),await evaluate(true,false),await evaluate(true,true)]));`);
    const [first, changed, uncached, clean] = results;
    expect(first.isPassed).toBe(true);
    expect(changed.isPassed).toBe(false);
    expect(changed.isPassed).toBe(uncached.isPassed);
    expect(
      changed.events.find((event) => event.kind === 'semanticPrograms')?.count,
    ).toBeGreaterThan(0);

    expect(changed.events).toContainEqual(
      expect.objectContaining({ kind: 'factHits', count: 0 }),
    );
    expect(cacheCount(changed, 'restoredContexts')).toBe(0);
    expect(clean.isPassed).toBe(false);
    expect(clean.events).toContainEqual(
      expect.objectContaining({ kind: 'semanticPrograms', count: 0 }),
    );
    expectRestoredFacts(clean);
    expect(clean.events).toContainEqual(
      expect.objectContaining({ kind: 'unchanged', count: 1 }),
    );
  });

  it.each([
    { loader: 'native', extension: 'mjs' },
    { loader: 'tsx', extension: 'mjs' },
    { loader: 'native', extension: 'cjs' },
    { loader: 'tsx', extension: 'cjs' },
  ] as const)(
    'evaluates load-time data and transitive modules with $loader/$extension in independent processes',
    async ({ loader, extension }) => {
      const f = fixture();
      const isCommonJs = extension === 'cjs';
      f.write(
        `policy.${extension}`,
        isCommonJs
          ? 'exports.policy = process.env.LIMINA_CACHE_TEST_POLICY;'
          : 'export const policy = process.env.LIMINA_CACHE_TEST_POLICY;',
      );
      f.write(
        `limina.config.${extension}`,
        isCommonJs
          ? 'const { policy } = require("./policy.cjs"); module.exports = { pipelines: { [policy]: [] } };'
          : 'import { policy } from "./policy.mjs"; export default {pipelines: { [policy]: [] }};',
      );
      const loaderUrl = new URL('../config/loader.ts', import.meta.url).href;
      const require = createRequire(import.meta.url);
      f.write(
        'runner.mjs',
        `import {loadConfig} from ${JSON.stringify(loaderUrl)};
const options = ${JSON.stringify({ configPath: f.file(`limina.config.${extension}`), configLoader: loader })};
const config=await loadConfig(options);
console.log(JSON.stringify([config.pipelines,Object.isFrozen(config.pipelines)]));`,
      );
      const evaluate = (policy: string) => {
        const output = execFileSync(
          process.execPath,
          [
            '--import',
            pathToFileURL(require.resolve('tsx')).href,
            f.file('runner.mjs'),
          ],
          {
            encoding: 'utf8',
            env: { ...process.env, LIMINA_CACHE_TEST_POLICY: policy },
          },
        );
        return JSON.parse(output.trim());
      };
      expect(evaluate('first')).toEqual([{ first: [] }, true]);
      expect(evaluate('second')).toEqual([{ second: [] }, true]);
      rmSync(f.file(`policy.${extension}`));
      f.write(
        `limina.config.${extension}`,
        isCommonJs ? 'module.exports = {};' : 'export default {};',
      );
      expect(evaluate('third')).toEqual([null, true]);
    },
  );

  it('owns nested pure data and cannot make callbacks equal by dropping functions', () => {
    const original = { rules: ['old'], callback: () => 'one' };
    const captured = captureInvocationData(original);
    original.rules.push('new');
    expect(captured.rules).toEqual(['old']);
    expect(invocationDataVersion(captured.rules)).toBeDefined();
    expect(invocationDataVersion(captured)).toBeUndefined();
    expect(captured.callback()).toBe('one');
    expect(invocationDataVersion({ value: null })).not.toBe(
      invocationDataVersion({}),
    );
    const arrayWithCallback = Object.assign(['first'], {
      callback: original.callback,
    });
    const ownArray = captureInvocationData(arrayWithCallback);
    expect(ownArray.callback()).toBe('one');
    expect(invocationDataVersion(ownArray)).toBeUndefined();
    expect(
      invocationDataVersion(Object.assign(['first'], { policy: 'deny' })),
    ).toBeUndefined();
    expect(invocationDataVersion(['first', 'second'])).not.toBe(
      invocationDataVersion(['second', 'first']),
    );
  });

  it('versions pure-data enumeration changes that change active checkers', () => {
    const configs = [false, true].map((enumerable) =>
      captureInvocationData({
        scope: {
          checkers: Object.defineProperty({}, 'tsc', {
            enumerable,
            value: { include: ['special/**/tsconfig.json'] },
          }),
        },
      }),
    );
    expect(
      configs.map((config) =>
        getActiveCheckers(config).map((checker) => checker.name),
      ),
    ).toEqual([[], ['tsc']]);
    const versions = configs.map(invocationDataVersion);
    expect(versions.every((version) => version !== undefined)).toBe(true);
    expect(versions[0]).not.toBe(versions[1]);
    expect(invocationDataVersion(captureInvocationData(configs[1]))).toBe(
      versions[1],
    );
  });

  it('retains executable proxy and array behavior without granting a pure-data version', () => {
    let current = 'first';
    const proxy = new Proxy(
      { value: 'first' },
      {
        get(target, key) {
          return key === 'value' ? current : Reflect.get(target, key);
        },
      },
    );
    class RuntimeEntries extends Array<string> {
      override [Symbol.iterator](): ArrayIterator<string> {
        return [current][Symbol.iterator]();
      }
    }
    const entries = new RuntimeEntries('first');
    const captured = captureInvocationData({ proxy, entries });
    current = 'second';
    expect(captured.proxy.value).toBe('second');
    expect([...captured.entries]).toEqual(['second']);
    expect(invocationDataVersion(captured.proxy)).toBeUndefined();
    expect(invocationDataVersion(captured.entries)).toBeUndefined();
    expect(invocationDataVersion(captured)).toBeUndefined();
  });

  it.each([false, true])(
    'keeps a legal continuing callback cold without overwriting a prior pure-data model (force: %s)',
    async (forceAnalysisCache) => {
      const f = fixture();
      const store = new AnalysisCacheStore({
        namespace: createLiminaArtifactNamespace({
          rootDir: f.root,
          generation: 0,
        }),
        configPath: f.config.configPath,
        identity: 'unused',
      });
      const seed = new LiminaPreflightManager({
        config: f.config,
        analysisCache: true,
      });
      await seed.ensureGeneratedGraph();
      await seed.publishAnalysisCache();
      seed.dispose();
      const bytes = readFileSync(store.path);
      const modified = statSync(store.path).mtimeMs;
      let environment = 'node';
      const config = {
        ...f.config,
        package: {
          entries: [
            {
              name: 'fixture',
              outDir: 'dist',
              boundary: { environment: () => environment },
            },
          ],
        },
      };
      for (const value of ['node', 'browser']) {
        environment = value;
        const events: { kind?: string; count?: number }[] = [];
        const manager = new LiminaPreflightManager({
          config,
          analysisCache: true,
          forceAnalysisCache,
          metrics: {
            record: (event) => {
              events.push(event);
            },
          },
        });
        try {
          await manager.ensureGeneratedGraph();
          await manager.publishAnalysisCache();
          expect(config.package.entries[0]?.boundary.environment()).toBe(value);
          expect(
            events.find((event) => event.kind === 'semanticPrograms')?.count,
          ).toBeGreaterThan(0);
          expect(
            events.find((event) => event.kind === 'graphBuilds')?.count,
          ).toBeGreaterThan(0);
          expect(events).toContainEqual(
            expect.objectContaining({ kind: 'factHits', count: 0 }),
          );
          expect(events).toContainEqual(
            expect.objectContaining({
              kind: 'fallback-configuration-version-unknown',
              count: 1,
            }),
          );
          expect(readFileSync(store.path)).toEqual(bytes);
          expect(statSync(store.path).mtimeMs).toBe(modified);
        } finally {
          manager.dispose();
        }
      }
    },
  );
});

interface GraphRunResult {
  ambiguities: { sourceConfigPath: string; checkers: string[] }[];
  graph: {
    manifest: GeneratedTsconfigGraphManifest;
    ownershipPlan: CheckerOwnershipPlan;
    edges: GeneratedDependencyEdge[];
  };
  events: AnalysisMetricMeasurement[];
  isPassed: boolean;
}

interface ProfiledGraphRunResult extends GraphRunResult {
  profile: AnalysisProfile;
}

function cacheCount(result: GraphRunResult, kind: string): number {
  return result.events.find((event) => event.kind === kind)?.count ?? 0;
}

function expectRestoredFacts(result: GraphRunResult): void {
  expect(cacheCount(result, 'restoredContexts')).toBeGreaterThan(0);
  expect(cacheCount(result, 'graphBuilds')).toBeGreaterThan(0);
}

describe('persistent Native conditional self-references', () => {
  const profiledRun =
    'console.log(JSON.stringify(await profileGraph({materialize:true})));';
  const consumerAdoption = expect.objectContaining({
    layer: 'native-context',
    stage: 'adoption',
    outcome: 'adopted',
    origin: 'prior-disk',
    subject: 'app/tsconfig.json',
  });

  function expectMaterializedReferences(
    f: ReturnType<typeof fixture>,
    modes: readonly ConditionalReferenceMode[],
  ): void {
    const manifest = JSON.parse(
      readFileSync(f.file('.limina/manifest.json'), 'utf8'),
    ) as GeneratedTsconfigGraphManifest;
    const mapping = manifest.checkers.tsc!.sourceToDts;
    const references = (source: string) => {
      const config = f.file(mapping[source]!);
      const parsed = ts.getParsedCommandLineOfConfigFile(
        config,
        {},
        {
          ...ts.sys,
          onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
            throw new Error(
              ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
            );
          },
        },
      )!;
      expect(parsed.errors).toEqual([]);
      return (parsed.projectReferences ?? [])
        .map(({ path }) => normalizeAbsolutePath(path))
        .sort(compareCodeUnits);
    };
    expect(references('app/tsconfig.json')).toEqual(
      modes
        .map((mode) => f.file(mapping[conditionalProviders[mode].config]!))
        .sort(compareCodeUnits),
    );
    for (const { config } of Object.values(conditionalProviders)) {
      expect(references(config)).toEqual([]);
    }
  }

  it('restores both conditional self-reference occurrences to erased generated configs', () => {
    const modes = ['require', 'import'] as const;
    const f = fixture(conditionalReferenceFiles(modes));
    const cold = f.execute<ProfiledGraphRunResult>(profiledRun);
    expectConditionalReferenceEdges(cold.graph.edges, f.file, modes);
    expectMaterializedReferences(f, modes);

    const store = new AnalysisCacheStore({
      namespace: createLiminaArtifactNamespace({
        rootDir: f.root,
        generation: 0,
      }),
      configPath: f.config.configPath,
      identity: 'unused',
    });
    expect(statSync(store.path).isFile()).toBe(true);
    rmSync(f.file('.limina/tsconfig'), { recursive: true });
    rmSync(f.file('.limina/manifest.json'));

    const warm = f.execute<ProfiledGraphRunResult>(profiledRun);
    expect(warm.profile.decisions).toContainEqual(consumerAdoption);
    expect(warm.events).toContainEqual(
      expect.objectContaining({ kind: 'semanticPrograms', count: 0 }),
    );
    expectConditionalReferenceEdges(warm.graph.edges, f.file, modes);
    expectMaterializedReferences(f, modes);
  }, 60_000);

  it('rebuilds a consumer when its conditional self-reference switches resolution mode', () => {
    const f = fixture(conditionalReferenceFiles(['require']));
    const cold = f.execute<ProfiledGraphRunResult>(profiledRun);
    expectConditionalReferenceEdges(cold.graph.edges, f.file, ['require']);
    expectMaterializedReferences(f, ['require']);

    f.write(
      'app/index.ts',
      conditionalReferenceFiles(['import'])['app/index.ts']!,
    );
    const changed = f.execute<ProfiledGraphRunResult>(profiledRun);
    expect(changed.profile.decisions).not.toContainEqual(consumerAdoption);
    expect(changed.events).toContainEqual(
      expect.objectContaining({
        name: 'analysis-cache',
        kind: 'context-rebuilt',
        provider: 'typescript',
        context: f.file('app/tsconfig.json'),
      }),
    );
    expect(cacheCount(changed, 'semanticPrograms')).toBeGreaterThan(0);
    expectConditionalReferenceEdges(changed.graph.edges, f.file, ['import']);
    expectMaterializedReferences(f, ['import']);
  }, 60_000);
});

it('revalidates the containing scope when a manifest shadows and releases a source subtree', () => {
  const f = fixture();
  rmSync(f.file('package-lock.json'));
  f.write(
    'limina.config.mjs',
    'export default {scope:{regions:{extendNestedPackageScopes:true},checkers:{tsc:{include:["**/tsconfig.json"]}}}};',
  );
  f.write('src/inner/index.ts', 'export const inner = 1;');
  const run = 'console.log(JSON.stringify(await runCache()));';
  const seed = f.execute<GraphRunResult>(run);
  expectRestoredFacts(f.execute<GraphRunResult>(run));
  f.write('src/inner/package.json', '{}');
  expect(() => f.execute<GraphRunResult>(run)).toThrow(
    /crosses its nearest package.json scope/u,
  );
  const options = { module: 'NodeNext', noLib: true, types: [] };
  f.write(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: options,
      files: ['src/a.ts', 'src/value.d.ts'],
    }),
  );
  f.write(
    'src/inner/tsconfig.json',
    JSON.stringify({ compilerOptions: options, files: ['index.ts'] }),
  );
  const profiled = 'console.log(JSON.stringify(await profileGraph()));';
  const warm = f.execute<ProfiledGraphRunResult>(profiled);
  const cold = f.execute<GraphRunResult>(
    'console.log(JSON.stringify(await runCache({cache:false})));',
  );
  expect(graphMeaning(warm.graph)).toEqual(graphMeaning(cold.graph));
  const store = new AnalysisCacheStore({
    namespace: createLiminaArtifactNamespace({
      rootDir: f.root,
      generation: 0,
    }),
    configPath: f.config.configPath,
    identity: 'unused',
  });
  const bindings = readStoredAnalysisSnapshot(store.path).header.packageScopes;
  expect(bindings.configs[f.file('src/inner/tsconfig.json')]).toEqual({
    role: 'source',
    scope: f.file('src/inner/package.json'),
  });
  const invalidation = (profile: AnalysisProfile) =>
    profile.decisions
      .filter(
        (decision) =>
          decision.layer === 'package-scope' &&
          decision.stage === 'admission' &&
          decision.outcome === 'rejected',
      )
      .map(({ subject, causes }) => [subject, causes?.[0].code]);
  expect(invalidation(warm.profile)).toEqual(
    expect.arrayContaining([
      ['tsconfig.json', 'package-scope-containing-boundary-changed'],
      ['src/inner/tsconfig.json', 'package-scope-binding-changed'],
    ]),
  );
  const innerProject = warm.profile.projects.find(
    (project) => project.path === 'src/inner/tsconfig.json',
  );
  expect(innerProject).toBeDefined();
  for (const event of [
    'configs-scanned',
    'configs-bound',
    'configs-invalidated',
  ])
    expect(warm.profile.metrics).toContainEqual({
      key: `cache.package-scope.${event}`,
      scope: ['project', innerProject?.id],
      value: 1,
      kind: 'counter',
      unit: 'items',
    });
  rmSync(f.file('src/inner/package.json'));
  rmSync(f.file('src/inner/tsconfig.json'));
  f.write(
    'tsconfig.json',
    JSON.stringify({ compilerOptions: options, include: ['src/**/*'] }),
  );
  const reflow = f.execute<ProfiledGraphRunResult>(profiled);
  expect(invalidation(reflow.profile)).toEqual(
    expect.arrayContaining([
      ['tsconfig.json', 'package-scope-containing-boundary-changed'],
      ['src/inner/tsconfig.json', 'package-scope-binding-changed'],
    ]),
  );
  expect(reflow.profile.projects.map(({ path }) => path)).not.toContain(
    'src/inner/tsconfig.json',
  );
  expect(reflow.graph.edges).toEqual(seed.graph.edges);
  const clean = f.execute<GraphRunResult>(
    'console.log(JSON.stringify(await runCache({cache:false})));',
  );
  expect(graphMeaning(reflow.graph)).toEqual(graphMeaning(clean.graph));
  expect(
    readStoredAnalysisSnapshot(store.path).header.packageScopes.manifests[
      f.file('src/inner/package.json')
    ],
  ).toBeUndefined();
}, 60_000);

function solutionRetirementFixture() {
  const f = fixture();
  const leaf = 'retired/tsconfig.leaf.json';
  const active = 'active/tsconfig.leaf.json';
  const compilerOptions = { noLib: true, types: [], module: 'NodeNext' };
  const setSolution = (paths: string[]) =>
    f.write(
      'tsconfig.json',
      JSON.stringify({
        files: [],
        references: paths.map((path) => ({ path })),
      }),
    );
  const setActive = (base?: string) =>
    f.write(
      active,
      JSON.stringify({
        ...(base !== undefined && { extends: `../${base}` }),
        compilerOptions,
        files: ['entry.ts', 'value.ts'],
      }),
    );
  const setLeaf = (isStrict: boolean) =>
    f.write(
      leaf,
      JSON.stringify({
        compilerOptions: { ...compilerOptions, strict: isStrict },
        files: ['value.ts'],
      }),
    );
  setLeaf(false);
  f.write('retired/value.ts', 'export const retired = 1;');
  f.write('active/value.ts', 'export const active = 1;');
  f.write('active/entry.ts', 'export { active } from "./value.js";');
  const run = () =>
    f.execute<GraphRunResult>('console.log(JSON.stringify(await runCache()));');
  const store = new AnalysisCacheStore({
    namespace: createLiminaArtifactNamespace({
      rootDir: f.root,
      generation: 0,
    }),
    configPath: f.config.configPath,
    identity: 'unused',
  });
  return { ...f, active, leaf, run, setActive, setLeaf, setSolution, store };
}

describe('retirement of graph config inputs', () => {
  it.each(['solution leaf', 'extends ancestor'] as const)(
    'reuses analysis facts when an unconsumed %s changes',
    (kind) => {
      const f = solutionRetirementFixture();
      const ancestor = '00-config/base.json';
      const retiredPath = kind === 'solution leaf' ? f.leaf : ancestor;
      const setAncestor = (isStrict: boolean) =>
        f.write(
          ancestor,
          JSON.stringify({ compilerOptions: { strict: isStrict } }),
        );
      setAncestor(false);
      f.setActive(kind === 'extends ancestor' ? ancestor : undefined);
      f.setSolution(kind === 'solution leaf' ? [f.active, f.leaf] : [f.active]);
      f.run();
      const cold = readStoredAnalysisSnapshot(f.store.path);
      const receipt = JSON.stringify([
        'physical',
        'config-mtime',
        f.file(retiredPath),
      ]);
      expect(cold.inputs[receipt]).toBeDefined();

      if (kind === 'solution leaf') f.setSolution([f.active]);
      else f.setActive();
      const current = f.run();
      const index = readFileSync(f.store.path);
      const stored = readStoredAnalysisSnapshot(f.store.path);

      if (kind === 'solution leaf') f.setLeaf(true);
      else setAncestor(true);
      const restored = f.run();
      expectRestoredFacts(restored);
      expect(cacheCount(restored, 'semanticPrograms')).toBe(0);
      expect(cacheCount(restored, 'resolverCalls')).toBe(0);
      expect(
        restored.events.find(({ kind }) => kind === 'resolvedConfigParses')
          ?.count,
      ).toBeLessThanOrEqual(2);
      expect(graphMeaning(restored.graph)).toEqual(graphMeaning(current.graph));
      expect(readFileSync(f.store.path)).toEqual(index);
      expect(stored.inputs[receipt]).toBeUndefined();
    },
  );

  it('keeps a retired leaf live through extends and resolves its ownership when it re-enters the solution', () => {
    const f = solutionRetirementFixture();
    f.setActive(f.leaf);
    f.setSolution([f.active, f.leaf]);
    const cold = f.run();
    expect(
      cold.events.find(({ kind }) => kind === 'resolverCalls')?.count,
    ).toBeGreaterThan(0);

    f.setSolution([f.active]);
    const retired = f.run();
    expect(
      retired.events.find(({ kind }) => kind === 'resolverCalls')?.count,
    ).toBe(0);

    f.setLeaf(true);
    const changed = f.run();
    expect(changed.events).toContainEqual(
      expect.objectContaining({ kind: 'graphBuilds', count: 1 }),
    );
    expect(changed.events).toContainEqual(
      expect.objectContaining({ kind: 'ownershipResolutions', count: 1 }),
    );

    f.setSolution([f.active, f.leaf]);
    const reentered = f.run();
    expect(cacheCount(reentered, 'ownershipResolutions')).toBe(2);
    expect(reentered.graph.manifest).toEqual(cold.graph.manifest);
  });
});

function frameworkBindingFixture(checker: 'astro' | 'svelte-check') {
  const f = fixture();
  const packages: [string, string][] =
    checker === 'astro'
      ? [
          ['astro', 'astro'],
          ['@astrojs/check', '@astrojs/check'],
        ]
      : [
          ['svelte', 'svelte-v4-min'],
          ['svelte-check', 'svelte-check-v4-min'],
          ['svelte2tsx', 'svelte2tsx'],
        ];
  const dependencies: [string, string][] = [
    ['typescript', 'typescript'],
    ...packages,
  ];
  for (const [name, installed] of dependencies) {
    const installedPackage = new URL(
      `../../node_modules/${installed}`,
      import.meta.url,
    );
    const target = f.file('node_modules', name);
    mkdirSync(path.dirname(target), { recursive: true });
    symlinkSync(
      realpathSync.native(fileURLToPath(installedPackage)),
      target,
      'junction',
    );
  }
  if (checker === 'astro') {
    const versions = Object.fromEntries(
      dependencies.map(([name]) => {
        const manifest = JSON.parse(
          readFileSync(f.file('node_modules', name, 'package.json'), 'utf8'),
        ) as { version: string };
        return [name, manifest.version] as const;
      }),
    );
    f.write(
      'package.json',
      JSON.stringify({
        name: 'fixture',
        private: true,
        type: 'commonjs',
        packageManager: 'npm@11.6.1',
        devDependencies: versions,
      }),
    );
  }
  f.write(
    'limina.config.mjs',
    `export default {scope:{source:{include:["provider/src/**/*","consumer/src/**/*"]},checkers:{tsc:{include:["provider/tsconfig.json"]},"${checker}":{include:["consumer/tsconfig.json"]}}}};`,
  );
  f.write(
    'tsconfig.json',
    JSON.stringify({
      files: [],
      references: [{ path: './provider' }, { path: './consumer' }],
    }),
  );
  const compilerOptions = {
    composite: true,
    declaration: true,
    noLib: true,
    types: [],
    module: 'ESNext',
    moduleResolution: 'Bundler',
  };
  f.write(
    'provider/tsconfig.json',
    JSON.stringify({ compilerOptions, files: ['src/value.ts'] }),
  );
  f.write(
    'consumer/tsconfig.json',
    JSON.stringify({ compilerOptions, include: ['src/**/*'] }),
  );
  f.write('provider/src/value.ts', 'export const value = 1;');
  f.write('consumer/src/local.ts', 'export const local = 1;');
  const imports =
    'import { value } from "../../provider/src/value.js"; import { local } from "./local.js";';
  if (checker === 'astro')
    f.write(
      'consumer/src/App.astro',
      `---\n${imports}\n---\n<p>{value + local}</p>`,
    );
  else
    f.write(
      'consumer/src/App.svelte',
      `<script lang="ts">${imports}</script><p>{value + local}</p>`,
    );
  return f;
}

describe('framework graph binding', () => {
  it('recomputes live source authority before restoring facts across a TypeScript to Svelte change', () => {
    const f = frameworkBindingFixture('svelte-check');
    f.write(
      'limina.config.mjs',
      'export default {scope:{source:{include:["provider/src/**/*","consumer/src/**/*"]}}};',
    );
    const setInclude = (include: string[]) =>
      f.write(
        'consumer/tsconfig.json',
        JSON.stringify({
          compilerOptions: {
            composite: true,
            declaration: true,
            noLib: true,
            types: [],
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include,
        }),
      );
    const run = () =>
      f.execute<ProfiledGraphRunResult>(
        'console.log(JSON.stringify(await profileGraph({})));',
      );
    const store = new AnalysisCacheStore({
      namespace: createLiminaArtifactNamespace({
        rootDir: f.root,
        generation: 0,
      }),
      configPath: f.config.configPath,
      identity: 'unused',
    });
    const authority = () =>
      readStoredAnalysisSnapshot(store.path).sourceConfigs[
        f.file('consumer/tsconfig.json')
      ]?.authority;
    const authorityDecisions = (result: ProfiledGraphRunResult) =>
      result.profile.decisions.filter(
        ({ layer }) => layer === 'source-config-authority',
      );

    setInclude(['src/**/*.ts']);
    const cold = run();
    expect(authority()).toMatchObject({
      family: 'typescript',
      provider: 'native-typescript',
    });
    expect(cacheCount(cold, 'semanticPrograms')).toBeGreaterThan(0);
    setInclude(['src/**/*.ts', 'src/**/*.svelte']);
    const changed = run();
    expect(authority()).toMatchObject({ family: 'svelte', provider: 'svelte' });
    expect(authorityDecisions(changed)).toContainEqual(
      expect.objectContaining({
        stage: 'admission',
        outcome: 'rejected',
        causes: [{ code: 'semantic-authority-changed' }],
      }),
    );
    expect(cacheCount(changed, 'semanticPrograms')).toBeGreaterThan(0);
    const warm = run();
    expect(authority()).toMatchObject({ family: 'svelte', provider: 'svelte' });
    expect(authorityDecisions(warm)).not.toContainEqual(
      expect.objectContaining({
        stage: 'admission',
        outcome: 'rejected',
        causes: [{ code: 'semantic-authority-changed' }],
      }),
    );
    expectRestoredFacts(warm);
  }, 60_000);

  it('recomputes framework scheduling when the materialized manifest is corrupted', () => {
    const f = frameworkBindingFixture('svelte-check');
    const run =
      'console.log(JSON.stringify(await runCache({materialize:true})));';
    const initial = f.execute<GraphRunResult>(run);
    const manifest = f.file('.limina', 'manifest.json');
    const initialManifest = readFileSync(manifest);
    expect(initial.graph.edges).toContainEqual(
      expect.objectContaining({
        kind: 'framework-schedule',
        fromConfigPath: f.file('consumer/tsconfig.json'),
        toConfigPath: f.file('provider/tsconfig.json'),
        importedSpecifier: '../../provider/src/value.js',
      }),
    );
    const edited = structuredClone(initial.graph.manifest);
    const schedule = edited.dependencyEdges.find(
      (edge) => edge.kind === 'framework-schedule',
    );
    expect(schedule).toBeDefined();
    schedule!.importedSpecifier = './incorrect-dependency.js';
    writeFileSync(manifest, JSON.stringify(edited));
    const rebuilt = f.execute<GraphRunResult>(run);
    expectRestoredFacts(rebuilt);
    expect(graphMeaning(rebuilt.graph)).toEqual(graphMeaning(initial.graph));
    expect(readFileSync(manifest)).toEqual(initialManifest);
    const restored = f.execute<GraphRunResult>(run);
    expectRestoredFacts(restored);
    expect(graphMeaning(restored.graph)).toEqual(graphMeaning(initial.graph));
    expect(readFileSync(manifest)).toEqual(initialManifest);
  }, 60_000);

  it('exports from a fresh process after Astro graph checking observes another compiler boundary', () => {
    const f = frameworkBindingFixture('astro');
    const prepared = f.execute<GraphRunResult>(
      'console.log(JSON.stringify(await runCache({materialize:true, check:true})));',
    );
    expect(prepared.isPassed).toBe(true);
    const store = new AnalysisCacheStore({
      namespace: createLiminaArtifactNamespace({
        rootDir: f.root,
        generation: 0,
      }),
      configPath: f.config.configPath,
      identity: 'unused',
    });
    const original = readFileSync(store.path);
    const runner = new URL('../graph-check/runner.ts', import.meta.url).href;
    const exportGraph = (analysisCache: boolean | 'read-only') =>
      f.execute(`
const config=await loadConfig({configPath:${JSON.stringify(f.config.configPath)}});
const {runGraphExportImpl}=await import(${JSON.stringify(runner)});
const preflight=new LiminaPreflightManager({config,analysisCache:${JSON.stringify(analysisCache)}});
try { console.log(JSON.stringify(await runGraphExportImpl(config, { preflight, view: 'all' }))); }
finally { preflight.dispose(); }
`);
    expect(exportGraph('read-only')).toEqual(exportGraph(false));
    expect(readFileSync(store.path)).toEqual(original);
  }, 120_000);
});

describe('persistent analysis facts and publication', () => {
  it('binds the live producer receipt separately from ordinary analysis facts', () => {
    const f = fixture();
    f.write('src/a.ts', 'export const value = 1;');
    f.write(
      'src/globals.d.ts',
      [
        'Array<T>',
        'Boolean',
        'CallableFunction',
        'Function',
        'IArguments',
        'NewableFunction',
        'Number',
        'Object',
        'RegExp',
        'String',
      ]
        .map((name) => `interface ${name} {}`)
        .join('\n'),
    );
    const result = f.execute<{
      declared: number;
      ordinaryContexts: number;
      boundReceipt: boolean;
    }>(`
const { ensureBuilt } = await import(${JSON.stringify(new URL('../typecheck/checker/build-runner.ts', import.meta.url).href)});
const { createDefaultRunner } = await import(${JSON.stringify(new URL('../typecheck/targets.ts', import.meta.url).href)});
const config = await loadConfig({ configPath: ${JSON.stringify(f.config.configPath)} });
const builder = new LiminaPreflightManager({ config });
const seed = new LiminaPreflightManager({ config, analysisCache: true });
try {
  const {receipt} = await ensureBuilt({config, preflight:builder, cwd:${JSON.stringify(f.root)}, runner:createDefaultRunner({stdio:'ignore'})});
  await builder.prepareConsumerPhase(receipt);
  await seed.ensureGeneratedArtifactsMaterialized();
  await seed.publishAnalysisCache();
  const events=[];
  const ordinary = new LiminaPreflightManager({config, analysisCache:true, metrics:{record:event=>events.push(event)}});
  const consumer = new LiminaPreflightManager({config, analysisCache:true});
  try {
    await consumer.prepareConsumerPhase(receipt);
    await ordinary.ensureGeneratedGraph();
    await ordinary.publishAnalysisCache();
    const {graph} = await consumer.ensureGeneratedArtifactsMaterialized();
    console.log(JSON.stringify({
      declared: receipt.declarations.length,
      ordinaryContexts: events.find(event=>event.kind==='restoredContexts')?.count,
      boundReceipt: graph.producerBuildReceipt === receipt,
    }));
  }finally{ordinary.dispose();consumer.dispose();}
}finally{seed.dispose();builder.dispose();}
`);
    expect(result).toEqual({
      declared: 1,
      ordinaryContexts: expect.any(Number),
      boundReceipt: true,
    });
    expect(result.ordinaryContexts).toBeGreaterThan(0);
  });

  it.each([
    'changed options',
    'rebound extends',
    'new installation directory',
  ] as const)(
    'reuses the snapshot and rebuilds the affected authorities after %s',
    (change) => {
      const f = fixture();
      f.write('limina.config.mjs', 'export default {};');
      f.write('src/a.ts', 'export const independent = 1;');
      const rootConfig = JSON.parse(
        readFileSync(f.file('tsconfig.json'), 'utf8'),
      );
      rootConfig.include.push('src/**/*.astro', 'src/**/*.svelte');
      f.write('tsconfig.json', JSON.stringify(rootConfig));
      const preset = 'node_modules/fixture-preset/tsconfig.json';
      const base = '{"compilerOptions":{"strict":false}}';
      f.write(preset, base);
      f.write(
        'provider/tsconfig.json',
        JSON.stringify({
          extends: 'fixture-preset/tsconfig.json',
          compilerOptions: { noLib: true, types: [], module: 'NodeNext' },
          include: ['*.ts'],
        }),
      );
      f.write('provider/value.ts', 'export const provider = 1;');
      f.write('provider/index.ts', "export {provider} from './value.js';");
      if (change === 'rebound extends') {
        // Keep the installation fixed while TypeScript selects a nearer preset.
        const installed = f.file('node_modules/fixture-host/node_modules');
        mkdirSync(installed, { recursive: true });
        symlinkSync(installed, f.file('provider/node_modules'), 'junction');
      }
      const run = 'console.log(JSON.stringify(await runCache()));';
      const cold = f.execute<GraphRunResult>(run);
      expect(cold.events).toContainEqual(
        expect.objectContaining({ kind: 'ownershipResolutions', count: 2 }),
      );
      if (change === 'changed options') {
        f.write(preset, '{"compilerOptions":{"strict":true}}');
      } else {
        const ancestorTime = statSync(f.file(preset)).mtime;
        const localPreset = `provider/${preset}`;
        f.write(localPreset, base);
        utimesSync(f.file(localPreset), ancestorTime, ancestorTime);
      }
      const changed = f.execute<GraphRunResult>(run);
      expect(cacheCount(changed, 'ownershipResolutions')).toBe(2);
      expect(cacheCount(changed, 'read-block')).toBeGreaterThan(0);
      const resolutions = changed.events.find(
        ({ kind }) => kind === 'resolverCalls',
      );
      expect(resolutions?.count).toBeGreaterThan(0);
      const clean = f.execute<GraphRunResult>(
        'console.log(JSON.stringify(await runCache({cache:false})));',
      );
      expect(changed.ambiguities).toEqual([
        {
          sourceConfigPath: f.file('tsconfig.json'),
          checkers: ['astro', 'svelte-check'],
        },
      ]);
      expect(changed.ambiguities).toEqual(clean.ambiguities);
      expect(graphMeaning(changed.graph)).toEqual(graphMeaning(clean.graph));
    },
  );

  it.each([
    'missing-source',
    'missing-empty-source',
    'missing-occurrences',
    'orphan-fact',
    'duplicate-occurrence',
    'shifted-range',
    'wrong-kind',
    'missing-source-and-member',
    'missing-loaded-source',
    'missing-inventory',
    'foreign-proof-request',
    'foreign-proof-context',
    'orphan-obligation-request',
    'missing-obligations',
    'foreign-obligation-target',
  ] as const)(
    'recollects %s from the real store and publishes a complete JSDoc graph for the next process',
    (corruption) => {
      const f = fixture();
      f.write(
        'tsconfig.json',
        JSON.stringify({
          compilerOptions: {
            allowJs: true,
            checkJs: true,
            composite: true,
            declaration: true,
            noLib: true,
            types: [],
            module: 'NodeNext',
            outDir: 'dist',
          },
          files: ['src/a.js', 'src/value.d.ts', 'src/empty.ts'],
        }),
      );
      f.write(
        'src/a.js',
        '/** @type {import("./value.js").V} */\nexport let value;',
      );
      f.write('src/empty.ts', 'export const independent = 1;');
      const run = 'console.log(JSON.stringify(await runCache({check:true})));';
      const cold = f.execute<GraphRunResult>(run);
      const warm = f.execute<GraphRunResult>(run);
      expect(warm.graph).toEqual(cold.graph);
      expectRestoredFacts(warm);
      const store = new AnalysisCacheStore({
        namespace: createLiminaArtifactNamespace({
          rootDir: f.root,
          generation: 0,
        }),
        configPath: f.config.configPath,
        identity: 'unused',
      });
      const snapshot = readStoredAnalysisSnapshot(store.path);
      expect(cold.graph.ownershipPlan.dependencyFacts).toHaveLength(1);
      expect(cold.graph.ownershipPlan.dependencyFacts[0]?.importRecord).toEqual(
        expect.objectContaining({ specifier: './value.js' }),
      );
      const compilerEvidence = () =>
        Object.values(snapshot.contexts).map((context) => ({
          inventory: context.native?.inventory,
          requests: context.native?.snapshot.requests,
          resolutions: context.native?.snapshot.resolutions,
          coverage: context.native?.snapshot.coverageIndexes,
        }));
      const retainedEvidence = structuredClone(compilerEvidence());
      const corruptProofs = (value: unknown): void => {
        if (typeof value !== 'object' || value === null) return;
        const entry = value as Record<string, unknown>;
        if (corruption === 'missing-obligations') {
          if (Array.isArray(entry.obligations)) entry.obligations = [];
          if ('obligation' in entry) entry.obligation = null;
          if ('referenceRequirement' in entry)
            entry.referenceRequirement = null;
        }
        if ('existence' in entry && 'requestIds' in entry) {
          const obligation =
            entry as unknown as import('../domain/analysis/native-obligation').NativeCompilationObligation;
          if (obligation.existence.state !== 'unknown') {
            switch (corruption) {
              case 'foreign-proof-request': {
                Object.assign(obligation.existence.proof, {
                  evidenceId: 'unbound-request',
                });
                break;
              }
              case 'foreign-proof-context': {
                Object.assign(obligation.existence.proof, {
                  contextId: 'unbound-context',
                });
                break;
              }
              case 'orphan-obligation-request': {
                Object.assign(obligation, { requestIds: ['unbound-request'] });
                break;
              }
              case 'foreign-obligation-target': {
                const targetConfigId = f.file('foreign/tsconfig.json');
                Object.assign(obligation, { targetConfigId });
                if ('mapping' in obligation.structure)
                  Object.assign(obligation.structure.mapping, {
                    targetConfigId,
                  });
                break;
              }
            }
          }
        }
        for (const child of Object.values(entry)) corruptProofs(child);
      };
      if (corruption.includes('obligation') || corruption.includes('proof')) {
        // Corrupt every retained copy consistently, then publish through the
        // real checksummed envelope. Copy equality cannot validate provenance.
        corruptProofs(snapshot.contexts);
        corruptProofs(snapshot.importers);
      }
      for (const [contextId, context] of Object.entries(snapshot.contexts)) {
        const id = context.sources[f.file('src/a.js')];
        if (id == null) continue;
        const importer = snapshot.importers[id];
        expect(importer.occurrences).toHaveLength(1);
        const damage = () => {
          switch (corruption) {
            case 'missing-source': {
              delete context.sources[f.file('src/a.js')];
              break;
            }
            case 'missing-empty-source': {
              delete context.sources[f.file('src/empty.ts')];
              break;
            }
            case 'missing-occurrences': {
              importer.occurrences = [];
              importer.facts = {};
              break;
            }
            case 'orphan-fact': {
              importer.facts.orphan = structuredClone(
                Object.values(importer.facts)[0]!,
              );
              break;
            }
            case 'shifted-range':
            case 'wrong-kind': {
              const occurrence = importer.occurrences[0]!;
              const key = occurrenceKey(occurrence);
              const fact = importer.facts[key];
              delete importer.facts[key];
              if (corruption === 'shifted-range') {
                occurrence.locator.sourceStart += 100_000;
                occurrence.locator.sourceEnd += 100_000;
              } else occurrence.kind = 'export';
              importer.facts[occurrenceKey(occurrence)] = fact;
              break;
            }
            case 'missing-source-and-member':
            case 'missing-loaded-source': {
              const target = f.file('src/value.d.ts');
              expect(context.sources[target]).toBeTruthy();
              expect(context.native!.snapshot.resolutions).toContainEqual(
                expect.objectContaining({
                  compilerLoad: 'loaded',
                  target: expect.objectContaining({ lexicalPath: target }),
                }),
              );
              delete context.sources[target];
              snapshot.projects[contextId].members = snapshot.projects[
                contextId
              ].members.filter((member) => member !== target);
              if (corruption === 'missing-loaded-source') {
                context.native!.inventory = {
                  ...context.native!.inventory,
                  members: context.native!.inventory.members.filter(
                    (member) => member !== target,
                  ),
                };
              }
              break;
            }
            case 'missing-inventory': {
              Reflect.deleteProperty(context.native!, 'inventory');
              break;
            }
            case 'foreign-proof-request':
            case 'foreign-proof-context':
            case 'orphan-obligation-request':
            case 'missing-obligations':
            case 'foreign-obligation-target': {
              break;
            }
            default: {
              importer.occurrences.push(
                structuredClone(importer.occurrences[0]!),
              );
            }
          }
        };
        damage();
      }
      if (
        corruption === 'missing-obligations' ||
        corruption === 'foreign-obligation-target'
      )
        expect(compilerEvidence()).toEqual(retainedEvidence);
      writeStoredAnalysisSnapshot(store.path, snapshot);
      const rebuilt = f.execute<GraphRunResult>(run);
      expect(rebuilt.events).toContainEqual(
        expect.objectContaining({
          kind: 'semanticPrograms',
          count: expect.any(Number),
        }),
      );
      expect(
        rebuilt.events
          .filter((event) => event.kind === 'semanticPrograms')
          .reduce((sum, event) => sum + (event.count ?? 0), 0),
      ).toBeGreaterThan(0);
      expect(
        rebuilt.events.some(
          (event) => event.kind === 'restoredContexts' && event.count! > 0,
        ),
      ).toBe(false);
      expect(graphMeaning(rebuilt.graph)).toEqual(graphMeaning(cold.graph));
      const repaired = readStoredAnalysisSnapshot(store.path);
      expect(rebuilt.graph.ownershipPlan.dependencyFacts).toHaveLength(1);
      expect(rebuilt.isPassed).toBe(true);
      expect(repaired.header.revision).not.toBe(snapshot.header.revision);
      const recovered = f.execute<GraphRunResult>(run);
      expect(recovered.graph).toEqual(rebuilt.graph);
      expectRestoredFacts(recovered);
      expect(
        recovered.events.some(
          (event) => event.kind === 'semanticPrograms' && event.count! > 0,
        ),
      ).toBe(false);
      expect(readStoredAnalysisSnapshot(store.path)).toEqual(repaired);
    },
  );

  it.each(['missing', 'extra', 'redirected'] as const)(
    'reconstructs %s generated declaration references from current policy',
    (corruption) => {
      const f = fixture();
      const rootConfig = JSON.parse(
        readFileSync(f.file('tsconfig.json'), 'utf8'),
      );
      rootConfig.liminaOptions = {
        implicitRefs: [
          { path: './provider/tsconfig.json', reason: 'runtime input' },
        ],
      };
      f.write('tsconfig.json', JSON.stringify(rootConfig));
      f.write(
        'provider/tsconfig.json',
        JSON.stringify({
          compilerOptions: { noLib: true, types: [], module: 'NodeNext' },
          files: ['index.ts'],
        }),
      );
      f.write('provider/index.ts', 'export const provider = 1;');
      f.write(
        'limina.config.mjs',
        'export default {scope:{checkers:{tsc:{include:["tsconfig.json", "provider/tsconfig.json"]}}}};',
      );

      const run =
        'console.log(JSON.stringify(await runCache({materialize:true})));';
      const cold = f.execute<GraphRunResult>(run);
      const dts = cold.graph.manifest.checkers.tsc!.sourceToDts;
      const declaration = f.file(dts['tsconfig.json']!);
      const bytes = readFileSync(declaration, 'utf8');
      const config = JSON.parse(bytes);
      expect(config.references).toEqual([
        {
          path: `./${toPortableRelativePath(
            path.dirname(declaration),
            f.file(dts['provider/tsconfig.json']!),
          )}`,
        },
      ]);
      const foreign = { path: './foreign.dts.json' };
      if (corruption === 'extra') config.references.push(foreign);
      else config.references = corruption === 'missing' ? [] : [foreign];
      writeFileSync(declaration, JSON.stringify(config));

      const repaired = f.execute<GraphRunResult>(run);
      expectRestoredFacts(repaired);
      expect(cacheCount(repaired, 'semanticPrograms')).toBe(0);
      expect(graphMeaning(repaired.graph)).toEqual(graphMeaning(cold.graph));
      expect(readFileSync(declaration, 'utf8')).toBe(bytes);
    },
  );

  function oracleSupportFixture() {
    const f = fixture();
    f.write(
      'limina.config.mjs',
      'export default {scope:{checkers:{tsc:{include:["tsconfig.json","b/tsconfig.json"]}}}};',
    );
    f.write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          composite: true,
          declaration: true,
          noLib: true,
          types: [],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          allowJs: true,
          checkJs: true,
          maxNodeModuleJsDepth: 2,
        },
        files: ['src/a.ts', 'src/value.d.ts'],
      }),
    );
    f.write(
      'b/tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          composite: true,
          declaration: true,
          noLib: true,
          types: [],
        },
        files: ['index.ts'],
      }),
    );
    f.write('b/index.ts', 'export interface Value {n:number}');
    const addOracleSupport = () => {
      f.write('src/value.d.ts', 'import "compat";export interface V {}');
      f.write(
        'node_modules/compat/package.json',
        JSON.stringify({ name: 'compat', version: '1.0.0', main: 'index.js' }),
      );
      f.write(
        'node_modules/compat/index.js',
        'function use(require){return require("./nested");}export {};',
      );
      f.write(
        'node_modules/compat/nested.d.ts',
        'import type {Value} from "../../b/index";export declare const value:Value;',
      );
    };
    const run = () =>
      f.execute<GraphRunResult>(
        'console.log(JSON.stringify(await runCache()));',
      );
    return { ...f, addOracleSupport, run };
  }

  it('physically stops a non-root implementation while the full Oracle loads its support', () => {
    const f = oracleSupportFixture();
    f.run();
    expectRestoredFacts(f.run());
    f.addOracleSupport();
    const compatibility = f.run();
    expect(compatibility.graph.edges).toEqual([]);
    const original = f.project();
    const compilerProgram = ts.createProgram({
      rootNames: [...original.fileNames],
      options: original.options,
    });
    expect(
      compilerProgram.getSourceFile(f.file('node_modules/compat/nested.d.ts')),
    ).toBeDefined();
    expect(
      compatibility.events.find((event) => event.kind === 'semanticPrograms')
        ?.count,
    ).toBeGreaterThan(0);
  });

  it('restores the non-root boundary and recognizes a later direct reference', () => {
    const f = oracleSupportFixture();
    f.addOracleSupport();
    const compatibility = f.run();
    expect(compatibility.graph.edges).toEqual([]);
    const restored = f.run();
    expect(restored.graph).toEqual(compatibility.graph);
    expectRestoredFacts(restored);
    expect(restored.events).toContainEqual(
      expect.objectContaining({ kind: 'semanticPrograms', count: 0 }),
    );
    f.write(
      'src/value.d.ts',
      'import type {Value} from "../b/index";export interface V extends Value {}',
    );
    const recovered = f.run();
    expect(recovered.graph.edges.map((edge) => edge.toConfigPath)).toEqual([
      f.file('b/tsconfig.json'),
    ]);
    expect(
      recovered.events.find((event) => event.kind === 'semanticPrograms')
        ?.count,
    ).toBeGreaterThan(0);
  });

  it('rejects invalid configuration before adopting or replacing a warm snapshot', () => {
    const f = fixture();
    const run = 'console.log(JSON.stringify(await runCache()));';
    f.execute<GraphRunResult>(run);
    const warm = f.execute<GraphRunResult>(run);
    expectRestoredFacts(warm);
    const store = new AnalysisCacheStore({
      namespace: createLiminaArtifactNamespace({
        rootDir: f.root,
        generation: 0,
      }),
      configPath: f.config.configPath,
      identity: 'unused',
    });
    const before = readFileSync(store.path);
    const mtime = statSync(store.path).mtimeMs;
    const validConfig = readFileSync(f.file('limina.config.mjs'), 'utf8');
    f.write(
      'limina.config.mjs',
      'export default {scope:{checkers:{tsc:{include:["tsconfig.json"]}}},experimental:true};',
    );
    const rejected = f.execute<{ error?: string }>(
      'try { console.log(JSON.stringify(await runCache())); } catch (error) { console.log(JSON.stringify({error: String(error)})); }',
    );
    expect(rejected.error).toContain('unknown Limina config field');
    expect(readFileSync(store.path)).toEqual(before);
    expect(statSync(store.path).mtimeMs).toBe(mtime);

    f.write('limina.config.mjs', validConfig);
    const recovered = f.execute<GraphRunResult>(run);
    expect(recovered.graph).toEqual(warm.graph);
    expectRestoredFacts(recovered);
    expect(recovered.events).toContainEqual(
      expect.objectContaining({ kind: 'semanticPrograms', count: 0 }),
    );
    expect(readFileSync(store.path)).toEqual(before);
    expect(statSync(store.path).mtimeMs).toBe(mtime);
  });

  it('restores read-only models but cannot publish newly analyzed source inputs', () => {
    const f = fixture();
    const store = new AnalysisCacheStore({
      namespace: createLiminaArtifactNamespace({
        rootDir: f.root,
        generation: 0,
      }),
      configPath: f.config.configPath,
      identity: 'unused',
    });
    f.execute('console.log(JSON.stringify(await runCache()));');
    const bytes = readFileSync(store.path);
    const modified = statSync(store.path).mtimeMs;
    const warm = f.execute<GraphRunResult>(
      'console.log(JSON.stringify(await runCache({cache:"read-only"})));',
    );
    expectRestoredFacts(warm);
    f.write('src/a.ts', 'export const changed = true;');
    const changed = f.execute<GraphRunResult>(
      'console.log(JSON.stringify(await runCache({cache:"read-only"})));',
    );
    expect(
      changed.events.find((event) => event.kind === 'semanticPrograms')?.count,
    ).toBeGreaterThan(0);

    expect(changed.events.some((event) => event.kind === 'write')).toBe(false);
    expect(readFileSync(store.path)).toEqual(bytes);
    expect(statSync(store.path).mtimeMs).toBe(modified);
  });

  it.each(
    ([true, 'read-only'] as const).flatMap((mode) =>
      [true, false].map((enumerable) => ({ mode, enumerable })),
    ),
  )(
    'honors cache: false (enumerable: $enumerable) over caller $mode and force without reading or changing a snapshot',
    ({ mode, enumerable }) => {
      const f = fixture();
      const store = new AnalysisCacheStore({
        namespace: createLiminaArtifactNamespace({
          rootDir: f.root,
          generation: 0,
        }),
        configPath: f.config.configPath,
        identity: 'unused',
      });
      const seed = f.execute<GraphRunResult>(
        'console.log(JSON.stringify(await runCache()));',
      );
      const warm = f.execute<GraphRunResult>(
        'console.log(JSON.stringify(await runCache()));',
      );
      expectRestoredFacts(warm);
      const bytes = readFileSync(store.path);
      const modified = statSync(store.path).mtimeMs;
      f.write(
        'limina.config.mjs',
        `export default Object.defineProperty({scope: {checkers:{tsc:{include:["tsconfig.json"]}}}}, 'cache', {value:false,enumerable:${enumerable}});`,
      );
      for (const isForced of [false, true]) {
        const result = f.execute<GraphRunResult>(
          `console.log(JSON.stringify(await runCache({cache:${JSON.stringify(mode)},force:${isForced}})));`,
        );
        expect(graphMeaning(result.graph)).toEqual(graphMeaning(seed.graph));
        expect(
          result.events.some((event) => event.name === 'analysis-cache'),
        ).toBe(false);
        expect(result.events).toContainEqual(
          expect.objectContaining({ name: 'bounded-program-create' }),
        );
        expect(readFileSync(store.path)).toEqual(bytes);
        expect(statSync(store.path).mtimeMs).toBe(modified);
      }
    },
  );

  it('projects a restored request-bearing root and its cyclic support declarations once', async () => {
    const f = fixture();
    f.write('src/empty.ts', 'export {};');
    f.write('src/a.ts', "export type { V } from '../support/first.js';");
    f.write('support/first.d.ts', "export type { V } from './second.js';");
    f.write(
      'support/second.d.ts',
      "import './first.js'; export type V = number;",
    );
    const project = f.project();
    const store = new AnalysisCacheStore({
      namespace: createLiminaArtifactNamespace({
        rootDir: f.root,
        generation: 0,
      }),
      configPath: f.config.configPath,
      identity: 'fixture',
      configVersion: 'fixture-config',
    });
    await store.publish(analyze(project).cache);
    const persisted = parseAnalysisSnapshot(
      readStoredAnalysisSnapshot(store.path),
      'fixture',
    );
    const restored = new NativeAnalysisCache(
      'fixture',
      persisted,
      'fixture-config',
    ).restoreContext(project)!;
    const importers = vi.spyOn(restored, 'getNativeFileRequests');
    const legacyRecords = vi.spyOn(restored, 'getImportRecords');
    const legacyFacts = vi.spyOn(restored, 'getDependencyFact');
    const facts = projectNativeReferenceFacts(restored, {
      fileNames: project.fileNames,
      compilerOptions: project.options,
      extensions: [],
    })!;
    expect(facts.dependencies.map((row) => row.importRecord.specifier)).toEqual(
      ['../support/first.js', './second.js', './first.js'],
    );
    expect(importers.mock.calls.map(([file]) => file)).toEqual([
      f.file('src/a.ts'),
      f.file('support/first.d.ts'),
      f.file('support/second.d.ts'),
    ]);
    expect(legacyRecords).not.toHaveBeenCalled();
    expect(legacyFacts).not.toHaveBeenCalled();
    expect(
      facts.ownershipInputs.map((row) => row.importRecord.filePath),
    ).toEqual([f.file('src/a.ts')]);
    expect(facts.referenceInputs).toEqual([]);
  });

  it('recomputes graph and materializes deleted artifacts from a clean facts snapshot', () => {
    const f = fixture();
    const sourceConfig = JSON.parse(
      readFileSync(f.file('tsconfig.json'), 'utf8'),
    );
    f.write(
      'tsconfig.json',
      JSON.stringify({
        ...sourceConfig,
        compilerOptions: {
          ...sourceConfig.compilerOptions,
          types: ['./env'],
          typeRoots: ['./types'],
        },
      }),
    );
    f.write('env.d.ts', 'export interface Competing {}');
    f.write('types/env/index.d.ts', 'export interface Selected {}');
    const profiledRun =
      'console.log(JSON.stringify(await profileGraph({materialize:true})));';
    const first = f.execute<ProfiledGraphRunResult>(profiledRun);
    for (const kind of [
      'semanticPrograms',
      'resolverCalls',
      'syntaxFactBuilds',
    ])
      expect(cacheCount(first, kind)).toBeGreaterThan(0);
    const manifest = f.file('.limina/manifest.json');
    const expectedManifest = readFileSync(manifest);
    const dts = f.file(
      first.graph.manifest.checkers.tsc!.sourceToDts['tsconfig.json']!,
    );
    const expectedDeclarations = readFileSync(dts);
    const store = new AnalysisCacheStore({
      namespace: createLiminaArtifactNamespace({
        rootDir: f.root,
        generation: 0,
      }),
      configPath: f.config.configPath,
      identity: 'unused',
    });
    const before = readFileSync(store.path);
    const encoded = readStoredAnalysisSnapshot(store.path);
    const persisted = parseAnalysisSnapshot(encoded, encoded.header.identity);
    expect(persisted).toBeDefined();
    expect(Object.values(persisted!.contexts)).toEqual(
      expect.arrayContaining([expect.objectContaining({ complete: true })]),
    );
    const mtime = statSync(store.path).mtimeMs;
    rmSync(f.file('.limina/tsconfig'), { recursive: true });
    rmSync(manifest);
    const next = f.execute<ProfiledGraphRunResult>(profiledRun);
    expect(graphMeaning(next.graph)).toEqual(graphMeaning(first.graph));
    expect(readFileSync(manifest)).toEqual(expectedManifest);
    expect(readFileSync(dts)).toEqual(expectedDeclarations);
    expect(cacheCount(next, 'nativeReferenceFactProjections')).toBeGreaterThan(
      0,
    );
    expect(cacheCount(next, 'graphAdapterCollections')).toBe(0);
    const sourceProject = next.profile.projects.find(
      ({ path }) => path === 'tsconfig.json',
    );
    expect(sourceProject).toBeDefined();
    expect(first.profile.work).toContainEqual(
      expect.objectContaining({
        op: 'source-config.live-parse',
        scope: [
          'project',
          first.profile.projects.find(({ path }) => path === 'tsconfig.json')
            ?.id,
        ],
        end: 'performed',
      }),
    );
    const sourceRead = next.profile.work.find(
      ({ op, scope }) =>
        op === 'source-config.authorized-read' &&
        scope[1] === sourceProject?.id,
    );
    expect(sourceRead).toBeDefined();
    expect(next.profile.decisions).toContainEqual(
      expect.objectContaining({
        work: sourceRead?.id,
        layer: 'resolved-config-projection',
        stage: 'adoption',
        outcome: 'adopted',
        origin: 'prior-disk',
        subject: 'tsconfig.json',
      }),
    );
    expect(next.profile.work).not.toContainEqual(
      expect.objectContaining({ op: 'source-config.live-parse' }),
    );
    expect(
      next.profile.metrics.filter(
        ({ key, unit }) =>
          unit === 'calls' && key.startsWith('graph.reference-facts.'),
      ),
    ).toEqual([
      {
        key: 'graph.reference-facts.native.projection-attempts',
        scope: ['project', sourceProject?.id],
        value: 1,
        kind: 'counter',
        unit: 'calls',
      },
      {
        key: 'graph.reference-facts.native.projections',
        scope: ['project', sourceProject?.id],
        value: 1,
        kind: 'counter',
        unit: 'calls',
      },
      {
        key: 'graph.reference-facts.native.memo-hits',
        scope: ['project', sourceProject?.id],
        value: 2,
        kind: 'counter',
        unit: 'calls',
      },
    ]);
    expect(next.profile.metrics).toContainEqual({
      key: 'graph.reference-facts.native.projection-elapsed-sum',
      scope: ['project', sourceProject?.id],
      value: expect.any(Number),
      kind: 'counter',
      unit: 'us',
    });
    expect(cacheCount(next, 'graphBuilds')).toBe(1);
    expect(cacheCount(next, 'ownershipResolutions')).toBe(1);
    expect(cacheCount(next, 'resolvedConfigProjectionHits')).toBeGreaterThan(0);
    expect(cacheCount(next, 'resolverCalls')).toBe(0);
    expect(cacheCount(next, 'syntaxFactBuilds')).toBe(0);
    expectRestoredFacts(next);
    expect(next.events).toContainEqual(
      expect.objectContaining({ kind: 'semanticPrograms', count: 0 }),
    );
    expect(readFileSync(store.path)).toEqual(before);
    expect(statSync(store.path).mtimeMs).toBe(mtime);
  });
  it('cold-starts forced analysis, publishes its result and restores it on the next normal run', () => {
    const f = fixture();
    const store = new AnalysisCacheStore({
      namespace: createLiminaArtifactNamespace({
        rootDir: f.root,
        generation: 0,
      }),
      configPath: f.config.configPath,
      identity: 'unused',
    });
    const seed = f.execute<GraphRunResult>(
      'console.log(JSON.stringify(await runCache()));',
    );
    const before = readFileSync(store.path);
    const forced = f.execute<GraphRunResult>(
      'console.log(JSON.stringify(await runCache({force:true})));',
    );
    expect(graphMeaning(forced.graph)).toEqual(graphMeaning(seed.graph));
    expect(cacheCount(forced, 'restoredContexts')).toBe(0);
    expect(
      forced.events.find((event) => event.kind === 'semanticPrograms')?.count,
    ).toBeGreaterThan(0);
    expect(forced.events).toContainEqual(
      expect.objectContaining({ kind: 'write' }),
    );
    const refreshed = readFileSync(store.path);
    expect(refreshed).not.toEqual(before);
    const restored = f.execute<GraphRunResult>(
      'console.log(JSON.stringify(await runCache()));',
    );
    expect(restored.graph).toEqual(forced.graph);
    expectRestoredFacts(restored);
    expect(restored.events).toContainEqual(
      expect.objectContaining({ kind: 'semanticPrograms', count: 0 }),
    );
    expect(readFileSync(store.path)).toEqual(refreshed);
  });
  it('reuses updated analysis facts across a provider refresh before publication', () => {
    const f = fixture();
    f.execute('console.log(JSON.stringify(await runCache()));');
    f.write('src/a.ts', 'export const changed = 1;');
    const result = f.execute<GraphRunResult>(
      'console.log(JSON.stringify(await runCache({refresh:true,deferPublish:true})));',
    );
    expectRestoredFacts(result);
    expect(cacheCount(result, 'graphBuilds')).toBe(2);
    expect(result.graph.ownershipPlan.dependencyFacts).toEqual([]);
  });
  it('reuses validated analysis from the forced invocation after a provider refresh', () => {
    const f = fixture();
    const result = f.execute<GraphRunResult>(
      'console.log(JSON.stringify(await runCache({force:true,refresh:true})));',
    );
    const programs = result.events
      .filter((event) => event.kind === 'semanticPrograms')
      .map((event) => event.count);
    expect(programs[0]).toBeGreaterThan(0);
    expect(programs[1]).toBe(programs[0]);
    expectRestoredFacts(result);
  });
});

it('keeps the replacement live context usable when an older equal-context instance is disposed', () => {
  const f = fixture();
  const cache = new NativeAnalysisCache('fixture', undefined, 'fixture-config');
  const old = createBoundedTypeScriptSemanticContext(f.project(), {
    analysisCache: cache,
  });
  const current = createBoundedTypeScriptSemanticContext(f.project(), {
    analysisCache: cache,
  });
  old.dispose();
  const records = current.getImportRecords(f.file('src/a.ts'));
  expect(records.length).toBeGreaterThan(0);
  const facts = records.map((record) => current.getDependencyFact(record));
  current.dispose();
  expect(
    cache.restoreContext(f.project())?.getDependencyFact(records[0]!),
  ).toEqual(facts[0]);
});

it.each(['relative', 'package-import'])(
  'publishes the first materialized candidate and restores %s through a provider refresh without rewriting it',
  async (route) => {
    const f = fixture();
    if (route === 'package-import') {
      const manifest = JSON.parse(readFileSync(f.file('package.json'), 'utf8'));
      f.write(
        'package.json',
        JSON.stringify({
          ...manifest,
          imports: { '#value': './src/value.d.ts' },
        }),
      );
      f.write(
        'src/a.ts',
        "import type { V } from '#value'; export type T = V;",
      );
    }
    const run = () =>
      f.execute<GraphRunResult>(
        'console.log(JSON.stringify(await runCache({materialize:true})));',
      );
    const store = new AnalysisCacheStore({
      namespace: createLiminaArtifactNamespace({
        rootDir: f.root,
        generation: 0,
      }),
      configPath: f.config.configPath,
      identity: 'unused',
    });
    run();
    const bytes = readFileSync(store.path);
    const mtime = statSync(store.path).mtimeMs;
    run();
    expect(readFileSync(store.path)).toEqual(bytes);
    expect(statSync(store.path).mtimeMs).toBe(mtime);
  },
);

// These cases start up to five Node runners plus candidate Checker processes.
// Give slow Windows starts a case budget independent of the global default.
it.each(['Coverage', 'explicit choice'] as const)(
  'revokes a cached declaration context when %s changes',
  (change) => {
    const f = fixture();
    const compilerOptions = {
      // These cases govern fixture declarations, independently of default libs.
      noLib: true,
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      types: [],
    };
    const a = { compilerOptions, files: ['src/a.ts'] };
    const b = { compilerOptions, files: ['src/value.d.ts'] };
    const writeChoice = (config: string) =>
      f.write(
        'tsconfig.a.json',
        JSON.stringify({
          ...a,
          liminaOptions: {
            declarationContexts: [{ file: './src/value.d.ts', config }],
          },
        }),
      );
    const writeSolution = (configs: string[]) =>
      f.write(
        'tsconfig.json',
        JSON.stringify({
          files: [],
          references: configs.map((path) => ({ path })),
        }),
      );
    writeSolution([
      './tsconfig.a.json',
      './tsconfig.b.json',
      ...(change === 'explicit choice' ? ['./tsconfig.b2.json'] : []),
    ]);
    f.write('tsconfig.a.json', JSON.stringify(a));
    f.write('tsconfig.b.json', JSON.stringify(b));
    if (change === 'explicit choice') {
      f.write('tsconfig.b2.json', JSON.stringify(b));
      writeChoice('./tsconfig.b.json');
    }
    const run = 'console.log(JSON.stringify(await runCache()));';
    const first = f.execute<GraphRunResult>(run);
    const warm = f.execute<GraphRunResult>(run);
    expectRestoredFacts(warm);
    expect(warm.graph).toEqual(first.graph);
    if (change === 'Coverage') {
      f.write('tsconfig.b2.json', JSON.stringify(b));
      writeSolution([
        './tsconfig.a.json',
        './tsconfig.b.json',
        './tsconfig.b2.json',
      ]);
      const stopped = f.execute<{ error: string }>(
        'try { await runCache(); console.log(JSON.stringify({error:"not refused"})); } catch(error) { console.log(JSON.stringify({error:error.message})); }',
      );
      expect(stopped.error).toContain('Choose a declaration context');
      return;
    }
    writeChoice('./tsconfig.b2.json');
    const selected = f.execute<GraphRunResult>(run);
    expect(
      selected.graph.edges.map((edge) => [
        edge.fromConfigPath,
        edge.toConfigPath,
      ]),
    ).toEqual([
      [f.file('tsconfig.a.json'), f.file('tsconfig.b2.json')],
      [f.file('tsconfig.b.json'), f.file('tsconfig.b2.json')],
    ]);
    const restored = f.execute<GraphRunResult>(run);
    expect(restored.graph).toEqual(selected.graph);
    expectRestoredFacts(restored);
  },
  60_000,
);

it('revalidates declaration candidates and revokes the last independent types reference', () => {
  const f = fixture();
  const compilerOptions = {
    noLib: true,
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    types: [],
  };
  const a = {
    compilerOptions: {
      ...compilerOptions,
      noResolve: true,
      noUncheckedSideEffectImports: false,
      types: ['./src/value'],
    },
    files: ['src/a.ts'],
  };
  f.write(
    'tsconfig.json',
    JSON.stringify({
      files: [],
      references: [
        { path: './tsconfig.a.json' },
        { path: './tsconfig.b.json' },
      ],
    }),
  );
  f.write('tsconfig.a.json', JSON.stringify(a));
  f.write(
    'tsconfig.b.json',
    JSON.stringify({ compilerOptions, files: ['src/value.d.ts'] }),
  );
  f.write('src/a.ts', 'import "./value.js"; export const value = 1;');
  const run = 'console.log(JSON.stringify(await runCache()));';
  const first = f.execute<GraphRunResult>(run);
  expect(first.graph.edges.map((edge) => edge.toConfigPath)).toEqual([
    f.file('tsconfig.b.json'),
  ]);
  expect(first.events).toContainEqual(
    expect.objectContaining({
      name: 'declaration-candidate',
      kind: 'generation',
      count: 1,
    }),
  );
  const warm = f.execute<GraphRunResult>(run);
  expect(warm.graph).toEqual(first.graph);
  expectRestoredFacts(warm);
  expect(warm.events).toContainEqual(
    expect.objectContaining({
      name: 'declaration-candidate',
      kind: 'generation',
      count: 1,
    }),
  );
  expect(warm.events).toContainEqual(
    expect.objectContaining({ name: 'bounded-program-create', count: 1 }),
  );
  expect(
    warm.events.find((event) => event.kind === 'semanticPrograms')?.count ?? 0,
  ).toBe(0);
  f.write('src/a.ts', 'export const value = 1;');
  const typesOnly = f.execute<GraphRunResult>(run);
  expect(typesOnly.graph.edges).toEqual(first.graph.edges);
  a.compilerOptions.types = [];
  f.write('tsconfig.a.json', JSON.stringify(a));
  const removed = f.execute<GraphRunResult>(run);
  expect(removed.graph.edges).toEqual([]);
  const restored = f.execute<GraphRunResult>(run);
  expect(restored.graph).toEqual(removed.graph);
  expectRestoredFacts(restored);
}, 60_000);

it.each(['skipLibCheck', 'noCheck'] as const)(
  'rebuilds and restores an external declaration owner after enabling %s',
  (option) => {
    const f = fixture();
    const compilerOptions = {
      noLib: true,
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      types: [],
    };
    f.write(
      'tsconfig.json',
      JSON.stringify({
        files: [],
        references: [
          { path: './tsconfig.a.json' },
          { path: './tsconfig.b.json' },
        ],
      }),
    );
    f.write(
      'tsconfig.a.json',
      JSON.stringify({ compilerOptions, files: ['src/a.ts'] }),
    );
    const b = { compilerOptions, files: ['src/value.d.ts'] };
    f.write('tsconfig.b.json', JSON.stringify(b));
    const run = 'console.log(JSON.stringify(await runCache()));';
    const first = f.execute<GraphRunResult>(run);
    const warm = f.execute<GraphRunResult>(run);
    expectRestoredFacts(warm);
    f.write(
      'tsconfig.b.json',
      JSON.stringify({
        ...b,
        compilerOptions: { ...compilerOptions, [option]: true },
      }),
    );
    const updated = f.execute<GraphRunResult>(run);
    expect(cacheCount(updated, 'semanticPrograms')).toBeGreaterThan(0);
    expect(updated.events).toContainEqual(
      expect.objectContaining({
        name: 'declaration-candidate',
        kind: 'generation',
        count: 1,
      }),
    );
    expect(updated.graph.edges).toEqual(first.graph.edges);
    const restored = f.execute<GraphRunResult>(run);
    expect(restored.graph).toEqual(updated.graph);
    expectRestoredFacts(restored);
    expect(restored.events).toContainEqual(
      expect.objectContaining({
        name: 'declaration-candidate',
        kind: 'generation',
        count: 1,
      }),
    );
  },
  60_000,
);

it.each(['analysis-v29', 'canonical-membership', 'host-policy'] as const)(
  'cold-rebuilds declaration evidence after %s and restores the new publication',
  (corruption) => {
    const f = fixture();
    const run = 'console.log(JSON.stringify(await runCache()));';
    const cold = f.execute<GraphRunResult>(run);
    const store = new AnalysisCacheStore({
      namespace: createLiminaArtifactNamespace({
        rootDir: f.root,
        generation: 0,
      }),
      configPath: f.config.configPath,
      identity: 'unused',
    });
    const snapshot = readStoredAnalysisSnapshot(store.path);
    let changed = 0;
    const corrupt = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return;
      const entry = value as Record<string, unknown>;
      if (corruption === 'canonical-membership' && entry.match === 'lexical') {
        entry.match = 'canonical';
        changed++;
      }
      if (
        corruption === 'host-policy' &&
        typeof entry.hostContract === 'string'
      ) {
        entry.hostContract = 'foreign-case-policy';
        changed++;
      }
      for (const child of Object.values(entry)) corrupt(child);
    };
    if (corruption === 'analysis-v29') {
      snapshot.header.implementation = 'checker-declaration-supplements-v29';
      changed++;
    } else corrupt(snapshot.contexts);
    expect(changed).toBeGreaterThan(0);
    writeStoredAnalysisSnapshot(store.path, snapshot);
    const rebuilt = f.execute<GraphRunResult>(run);
    expect(graphMeaning(rebuilt.graph)).toEqual(graphMeaning(cold.graph));
    expect(
      rebuilt.events.some(
        (event) => event.kind === 'semanticPrograms' && event.count! > 0,
      ),
    ).toBe(true);
    const warm = f.execute<GraphRunResult>(run);
    expectRestoredFacts(warm);
    expect(
      warm.events.some(
        (event) => event.kind === 'semanticPrograms' && event.count! > 0,
      ),
    ).toBe(false);
  },
  60_000,
);

it('recomputes logical declaration membership after alias retargeting across fresh processes', () => {
  const f = fixture();
  f.write(
    'limina.config.mjs',
    'export default {scope:{checkers:{tsc:{include:["tsconfig.json","b/tsconfig.json"]}}}};',
  );
  f.write(
    'b/tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        composite: true,
        noLib: true,
        types: [],
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
      },
      files: ['../alias/value.d.ts'],
    }),
  );
  f.write('other/value.d.ts', 'export interface V { value: number }');
  symlinkSync(f.file('src'), f.file('alias'), 'junction');
  const run = 'console.log(JSON.stringify(await runCache()));';
  const cold = f.execute<GraphRunResult>(run);
  const warm = f.execute<GraphRunResult>(run);
  expectRestoredFacts(warm);
  rmSync(f.file('alias'), { recursive: true });
  symlinkSync(f.file('other'), f.file('alias'), 'junction');
  const changed = f.execute<GraphRunResult>(run);
  expect(
    changed.events.some(
      (event) => event.kind === 'semanticPrograms' && event.count! > 0,
    ),
  ).toBe(true);
  expect(changed.graph.edges).toEqual(cold.graph.edges);
  const decisions = (run: GraphRunResult) =>
    (
      run.graph
        .ownershipPlan as import('../core/build-graph/checker-ownership-types').CheckerOwnershipPlan
    ).declarationContexts!.map((decision) => ({
      file: decision.file.lexicalPath,
      selection: decision.selection,
      members: decision.coverage.members.map((member) => member.configId),
    }));
  expect(decisions(changed)).toEqual(decisions(cold));
  expectRestoredFacts(f.execute<GraphRunResult>(run));
}, 60_000);

it.skipIf(ts.sys.useCaseSensitiveFileNames)(
  'caches and restores a consumer project with a case-variant root import across fresh processes',
  () => {
    const f = fixture();
    f.write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          composite: true,
          declaration: true,
          forceConsistentCasingInFileNames: false,
          noLib: true,
          types: [],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          outDir: 'dist',
        },
        files: ['src/index.ts', 'src/Foo.ts'],
      }),
    );
    f.write('src/Foo.ts', 'export const value = 1;');
    f.write(
      'src/index.ts',
      'import { value } from "./foo.js"; export const result = value;',
    );
    const run = 'console.log(JSON.stringify(await runCache()));';
    const cold = f.execute<GraphRunResult>(run);
    expect(cold.graph.edges).toEqual([]);
    const warm = f.execute<GraphRunResult>(run);
    expect(warm.graph).toEqual(cold.graph);
    expectRestoredFacts(warm);
    expect(
      warm.events.find((event) => event.kind === 'semanticPrograms')?.count ??
        0,
    ).toBe(0);
  },
  60_000,
);

it('reassesses a missing Native import without creating a Program after warm adoption', () => {
  const f = fixture();
  f.write('limina.config.mjs', 'export default {scope:{checkers:{auto:{}}}};');
  rmSync(f.file('src/value.d.ts'));
  f.write(
    'src/a.ts',
    "export const value = 1; export type { Missing } from './missing.js';",
  );
  const oxc = pathToFileURL(
    createRequire(import.meta.url).resolve('oxc-resolver'),
  ).href;
  const script = `
import { ResolverFactory } from ${JSON.stringify(oxc)};
const original = ResolverFactory.prototype.resolveFileSync;
let freshLookups = 0;
ResolverFactory.prototype.resolveFileSync = function (...args) {
  if (args[1] === './missing.js') freshLookups++;
  return original.apply(this, args);
};
const { profile, ...result } = await profileGraph();
const programs = profile.work.filter(row =>
  row.op === 'native-program-create' && ['performed', 'computed'].includes(row.end),
).length;
console.log(JSON.stringify({ ...result, programs, freshLookups }));`;
  const run = () =>
    f.execute<GraphRunResult & { programs: number; freshLookups: number }>(
      script,
    );
  const cold = run();
  expect(cold.programs).toBeGreaterThan(0);
  expect(cold.freshLookups).toBeGreaterThan(0);
  const warm = run();
  expectRestoredFacts(warm);
  expect(warm.programs).toBe(0);
  expect(warm.freshLookups).toBeGreaterThan(0);
  expect(graphMeaning(warm.graph)).toEqual(graphMeaning(cold.graph));
}, 60_000);
