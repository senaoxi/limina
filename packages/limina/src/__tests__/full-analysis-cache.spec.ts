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
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTypeScriptCommandLine } from '../checker/project-base';
import {
  captureInvocationData,
  invocationDataVersion,
} from '../config/invocation-data';
import { getActiveCheckers } from '../config/runtime';
import { directoryFingerprint } from '../core/analysis-cache/directory-fingerprint';
import { observeInstallationDomain } from '../core/analysis-cache/installation-domain';
import { validateInstallationLock } from '../core/analysis-cache/installation-locks';
import { NativeAnalysisCache } from '../core/analysis-cache/native-cache';
import { occurrenceKey } from '../core/analysis-cache/semantic-state';
import { parseAnalysisSnapshot } from '../core/analysis-cache/snapshot-schema';
import type { StoredGraphData } from '../core/build-graph/analysis-cache-schema';
import { createBoundedTypeScriptSemanticContext } from '../core/typescript-semantic';
import type { TypeScriptSemanticProject } from '../core/typescript-semantic/contracts';
import { createWorkspaceSourceBoundary } from '../core/typescript-semantic/workspace-source-boundary';
import { createLiminaArtifactNamespace } from '../domain/artifacts/namespace';
import { LiminaPreflightManager } from '../preflight';
import { AnalysisCacheStore } from '../preflight/analysis-cache-store';
import {
  analysisBlockPath,
  decodeGraphProjection as decodeData,
  encodeGraphProjection as encodeData,
  readStoredAnalysisSnapshot,
  writeStoredAnalysisSnapshot,
} from './helpers/analysis-snapshot';
import { withFixtureGovernanceRoot } from './helpers/governance-root';
import { readFixtureSourceCoverage } from './helpers/native-coverage';
import { graphMeaning, nativeFactMeaning } from './helpers/native-meaning';
import { createFixturePathResolver } from './helpers/path';

const roots: string[] = [];
vi.mock('../core/analysis-cache/installation-locks', async (original) => {
  const locks =
    await original<
      typeof import('../core/analysis-cache/installation-locks')
    >();
  return {
    ...locks,
    validateInstallationLock: vi.fn(locks.validateInstallationLock),
  };
});
afterEach(() => {
  vi.clearAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const temporary = mkdtempSync(path.join(tmpdir(), 'limina-full-cache-'));
  const root = realpathSync.native(temporary);
  roots.push(root);
  const file = createFixturePathResolver(root);
  let mtime = Date.now();
  const write = (name: string, content: string) => {
    mkdirSync(path.dirname(file(name)), { recursive: true });
    writeFileSync(file(name), content);
    mtime += 1000;
    utimesSync(file(name), mtime / 1000, mtime / 1000);
  };
  write(
    'package.json',
    JSON.stringify({
      name: 'fixture',
      private: true,
      type: 'commonjs',
      packageManager: 'npm@11.6.1',
    }),
  );
  write(
    'package-lock.json',
    JSON.stringify({
      name: 'fixture',
      lockfileVersion: 3,
      packages: { '': {} },
    }),
  );
  write(
    'limina.config.mjs',
    'export default {scope: {checkers:{tsc:{include:["tsconfig.json"]}}}};',
  );
  write(
    'tsconfig.json',
    JSON.stringify({
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
  );
  write('src/a.ts', "import type { V } from './value.js'; export type T = V;");
  write('src/value.d.ts', 'export interface V { value: string }');
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
async function runCache(options={}) {
  const config=await loadConfig({configPath:${JSON.stringify(file('limina.config.mjs'))}});
  const events=[];
  const manager=new LiminaPreflightManager({config,analysisCache:options.cache==='read-only'?'read-only':options.cache!==false,forceAnalysisCache:options.force,metrics:{record:event=>events.push(event)}});
  try {
    if(options.materialize)await manager.ensureGeneratedArtifactsMaterialized();
    const graph=await manager.ensureGeneratedGraph();
    const isPassed=options.check ? await isRunGraphCheckImpl(config,{preflight:manager}) : true;
    await manager.publishAnalysisCache();
    if(options.refresh) {
      createPreflightGenerationController(manager).startNextGeneration();
      await manager.ensureGeneratedGraph();
      await manager.publishAnalysisCache();
    }
    return {graph:{manifest:graph.manifest,ownershipPlan:graph.ownershipPlan,edges:graph.dependencyEdges},events,isPassed};
  }finally{manager.dispose();}
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
  const cache = new NativeAnalysisCache('fixture', snapshot, 'fixture-config');
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
    const same = statSync(f.file('one.json')).mtime;
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

describe('R01 effective local metadata and installation trust', () => {
  it.each([
    { explicitRoots: false, environmentDocument: false },
    { explicitRoots: true, environmentDocument: false },
    { explicitRoots: false, environmentDocument: true },
    { explicitRoots: true, environmentDocument: true },
  ])(
    'restores a shared pnpm member without scanning installed roots (explicit: $explicitRoots, env document: $environmentDocument)',
    ({ explicitRoots, environmentDocument }) => {
      const f = fixture();
      const pnpmVersion = environmentDocument ? '12.10.1' : '11.28.3';
      f.write(
        'package.json',
        JSON.stringify({
          private: true,
          packageManager: `pnpm@${pnpmVersion}`,
        }),
      );
      rmSync(f.file('package-lock.json'));
      f.write('pnpm-workspace.yaml', 'packages: [packages/*]\n');
      const environment = environmentDocument
        ? `---\nlockfileVersion: 9\nimporters:\n  .:\n    configDependencies: {}\n    packageManagerDependencies:\n      pnpm: {specifier: 12.10.1, version: 12.10.1}\n---\n`
        : '';
      const projectLock =
        'lockfileVersion: 9\nimporters:\n  .: {}\n  packages/member: {}\n';
      f.write('pnpm-lock.yaml', environment + projectLock);
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
      const parses = vi.mocked(validateInstallationLock).mock.calls.length;
      expect(parses).toBeGreaterThan(0);
      const warm = analyze(
        f.project('packages/member/tsconfig.json'),
        first.cache,
      );
      expect(warm.restored).toBe(true);
      expect(validateInstallationLock).toHaveBeenCalledTimes(parses);
      expect(warm.cache.metrics.semanticPrograms).toBe(0);
      expect(warm.cache.metrics.localRootScans ?? 0).toBe(0);
      expect(warm.facts).toEqual(first.facts);
      const encoded = structuredClone(first.cache.snapshot());
      const context = Object.values(encoded.contexts)[0] as {
        environment: {
          domains: {
            adapter: string;
            locks: string[];
            dependencies: { inputId: string }[];
          }[];
        };
      };
      const domain = context.environment.domains[0]!;
      const receiptId = JSON.stringify(['physical', 'bytes', domain.locks[0]]);
      domain.dependencies = domain.dependencies.filter(
        (item) => item.inputId !== receiptId,
      );
      expect(parseAnalysisSnapshot(encoded, 'fixture')).toBeUndefined();
      const legacy = structuredClone(first.cache.snapshot());
      for (const value of Object.values(legacy.contexts) as (typeof context)[])
        for (const item of value.environment.domains)
          item.adapter = 'physical-installation-v1';
      expect(parseAnalysisSnapshot(legacy, 'fixture')).toBeUndefined();
      f.write(
        'packages/uncovered/package.json',
        '{"name":"uncovered","private":true}',
      );
      f.write('packages/uncovered/tsconfig.json', '{}');
      const other = new NativeAnalysisCache(
        'fixture',
        first.cache.snapshot(),
        'fixture-config',
      );
      expect(other.inputs.domainDirty).toBe(false);
      expect(() =>
        observeInstallationDomain({
          root: f.file(),
          configPath: f.file('packages/uncovered/tsconfig.json'),
          inputs: other.inputs,
        }),
      ).toThrow(
        `Lock does not cover resolution root: ${f.file('packages/uncovered')}`,
      );
      expect(validateInstallationLock).toHaveBeenCalledTimes(parses + 1);
      if (environmentDocument) {
        f.write(
          'pnpm-lock.yaml',
          environment.replaceAll('12.10.1', '12.10.2') + projectLock,
        );
        const changed = analyze(
          f.project('packages/member/tsconfig.json'),
          warm.cache,
        );
        expect(changed.restored).toBe(false);
        expect(
          vi.mocked(validateInstallationLock).mock.calls.length,
        ).toBeGreaterThan(parses + 1);
        expect(changed.cache.inputs.domainDirty).toBe(false);
        expect(changed.cache.metrics.semanticPrograms).toBe(1);
        expect(changed.cache.metrics.factHits).toBe(0);
        expect(changed.facts.map(nativeFactMeaning)).toEqual(
          first.facts.map(nativeFactMeaning),
        );
        expect(
          analyze(f.project('packages/member/tsconfig.json'), changed.cache)
            .restored,
        ).toBe(true);
      }
      f.write('packages/member/package-lock.json', '{"lockfileVersion":3}');
      const independent = analyze(
        f.project('packages/member/tsconfig.json'),
        warm.cache,
      );
      expect(independent.restored).toBe(false);
      expect(
        Object.values(independent.cache.contexts)[0]?.environment.evidence,
      ).toBe('unknown');
      rmSync(f.file('packages/member/package-lock.json'));
      f.write(
        'pnpm-lock.yaml',
        `${environment}lockfileVersion: 9\nimporters:\n  .: {}\n`,
      );
      const uncovered = analyze(
        f.project('packages/member/tsconfig.json'),
        warm.cache,
      );
      expect(uncovered.restored).toBe(false);
      expect(
        Object.values(uncovered.cache.contexts)[0]?.environment.evidence,
      ).toBe('unknown');
    },
  );

  it('keeps unknown installation coverage cold and recollects qualified facts', () => {
    const f = fixture();
    f.write(
      'node_modules/@types/pkg/index.d.ts',
      'declare const installed: string;',
    );
    rmSync(f.file('package-lock.json'));
    const project = {
      ...f.project(),
      options: { ...f.project().options, types: ['pkg'] },
    };
    const first = analyze(project);
    const warm = analyze(project, first.cache);
    expect(warm.restored).toBe(false);
    expect(warm.cache.metrics.semanticPrograms).toBe(1);
    expect(warm.cache.metrics.factHits).toBe(0);
    expect(warm.facts.map(nativeFactMeaning)).toEqual(
      first.facts.map(nativeFactMeaning),
    );
    expect(warm.facts[0]!.nativeEvidence!.origin.context.id).not.toBe(
      first.facts[0]!.nativeEvidence!.origin.context.id,
    );
    expect(collectContextEnvironment(warm)).toBe('unknown');
  });

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

  it('rebuilds a subscribed context on a related lock change and records trusted installation evidence', () => {
    const f = fixture();
    f.write(
      'node_modules/@types/pkg/index.d.ts',
      'declare const installed: string;',
    );
    const project = {
      ...f.project(),
      options: { ...f.project().options, types: ['pkg'] },
    };
    const first = analyze(project);
    expect(Object.values(first.cache.contexts)[0]?.environment.evidence).toBe(
      'lockfile-trusted',
    );
    expect(analyze(project, first.cache).restored).toBe(true);
    f.write(
      'package-lock.json',
      '{"name":"fixture","lockfileVersion":3,"packages":{"":{}},"revision":2}',
    );
    const next = analyze(project, first.cache);
    expect(next.cache.inputs.domainDirty).toBe(false);
    expect(next.cache.metrics.semanticPrograms).toBe(1);
    expect(next.cache.metrics.factHits).toBe(0);
    expect(next.restored).toBe(false);
    rmSync(f.file('package-lock.json'));
    expect(analyze(project, next.cache).restored).toBe(false);
  });

  it('scans structure and rejects failures while preserving the declared metadata blindspot', () => {
    const f = fixture();
    f.write('types/pkg/a.d.ts', 'old');
    const file = f.file('types/pkg/a.d.ts');
    const before = statSync(file).mtime;
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
    expect(changed.events).toContainEqual(
      expect.objectContaining({ kind: 'graphHits', count: 1 }),
    );
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
    expect(changed.events).not.toContainEqual(
      expect.objectContaining({ kind: 'graphHits', count: 1 }),
    );
    expect(clean.isPassed).toBe(false);
    expect(clean.events).toContainEqual(
      expect.objectContaining({ kind: 'semanticPrograms', count: 0 }),
    );
    expect(clean.events).toContainEqual(
      expect.objectContaining({ kind: 'graphHits', count: 1 }),
    );
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
  graph: {
    manifest: unknown;
    ownershipPlan: unknown;
    edges: { fromConfigPath: string; toConfigPath: string }[];
  };
  events: { name?: string; kind?: string; count?: number }[];
  isPassed: boolean;
}

describe('production graph snapshots and publication', () => {
  it('rebuilds a corrupt graph projection from qualified context facts and repairs the next invocation', () => {
    const f = fixture();
    const first = f.execute<GraphRunResult>(
      'console.log(JSON.stringify(await runCache()));',
    );
    const control = f.execute<GraphRunResult>(
      'console.log(JSON.stringify(await runCache()));',
    );
    expect(control.events).toContainEqual(
      expect.objectContaining({ kind: 'graphHits', count: 1 }),
    );
    const store = new AnalysisCacheStore({
      namespace: createLiminaArtifactNamespace({
        rootDir: f.root,
        generation: 0,
      }),
      configPath: f.config.configPath,
      identity: 'unused',
    });
    const index = JSON.parse(readFileSync(store.path, 'utf8'));
    const block = index.storage.blocks.find(
      (item: { kind: string }) => item.kind === 'graph',
    );
    expect(block).toBeDefined();
    writeFileSync(analysisBlockPath(store.path, block), '{corrupt projection');
    const repaired = f.execute<GraphRunResult>(
      'console.log(JSON.stringify(await runCache()));',
    );
    expect(graphMeaning(repaired.graph)).toEqual(graphMeaning(first.graph));
    expect(repaired.events).toContainEqual(
      expect.objectContaining({ kind: 'semanticPrograms', count: 0 }),
    );
    expect(repaired.events).toContainEqual(
      expect.objectContaining({ kind: 'graphBuilds', count: 1 }),
    );
    const next = f.execute<GraphRunResult>(
      'console.log(JSON.stringify(await runCache()));',
    );
    expect(next.events).toContainEqual(
      expect.objectContaining({ kind: 'graphHits', count: 1 }),
    );
  });
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
      const run = 'console.log(JSON.stringify(await runCache()));';
      const cold = f.execute<GraphRunResult>(run);
      const warm = f.execute<GraphRunResult>(run);
      expect(warm.graph).toEqual(cold.graph);
      expect(warm.events).toContainEqual(
        expect.objectContaining({ kind: 'graphHits', count: 1 }),
      );
      const store = new AnalysisCacheStore({
        namespace: createLiminaArtifactNamespace({
          rootDir: f.root,
          generation: 0,
        }),
        configPath: f.config.configPath,
        identity: 'unused',
      });
      const snapshot = readStoredAnalysisSnapshot(store.path);
      const before = decodeData(
        Object.values(snapshot.graphs)[0]!.data,
      ) as StoredGraphData;
      expect(before.ownershipPlan.dependencyFacts).toHaveLength(1);
      expect(before.ownershipPlan.ownershipSelectionFacts).toHaveLength(1);
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
        for (const graph of Object.values(snapshot.graphs)) {
          const data = decodeData(graph.data);
          corruptProofs(data);
          graph.data = encodeData(data);
        }
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
      expect(rebuilt.events).not.toContainEqual(
        expect.objectContaining({ kind: 'graphHits', count: 1 }),
      );
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
      const graph = decodeData(
        Object.values(repaired.graphs)[0]!.data,
      ) as StoredGraphData;
      expect(graph.ownershipPlan.dependencyFacts).toHaveLength(1);
      expect(graph.ownershipPlan.ownershipSelectionFacts).toHaveLength(1);
      expect(graph.dependencyAnalysis.outcome?.execution).toBe('completed');
      expect(repaired.header.revision).not.toBe(snapshot.header.revision);
      const recovered = f.execute<GraphRunResult>(run);
      expect(recovered.graph).toEqual(rebuilt.graph);
      expect(recovered.events).toContainEqual(
        expect.objectContaining({ kind: 'graphHits', count: 1 }),
      );
      expect(
        recovered.events.some(
          (event) => event.kind === 'semanticPrograms' && event.count! > 0,
        ),
      ).toBe(false);
      expect(readStoredAnalysisSnapshot(store.path)).toEqual(repaired);
    },
  );

  it.each([
    'old-graph-key',
    'missing-coloring-inputs',
    'forged-coloring-seed',
    'forged-manifest-owner',
    'forged-manifest-roots',
    'forged-manifest-targets',
    'missing-root-member',
    'foreign-target',
    'missing-native-proof',
    'missing-core-work',
    'foreign-candidate',
    'missing-generated-reference',
    'extra-generated-reference',
    'redirected-generated-reference',
    'consistent-reference-removal',
  ] as const)(
    'rejects ownership %s in a valid storage envelope and restores the recollected result',
    (corruption) => {
      const f = fixture();
      if (corruption.includes('reference')) {
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
      }

      const run = 'console.log(JSON.stringify(await runCache()));';
      const first = f.execute<GraphRunResult>(run);
      const warm = f.execute<GraphRunResult>(run);
      expect(warm.graph).toEqual(first.graph);
      expect(warm.events).toContainEqual(
        expect.objectContaining({ kind: 'graphHits', count: 1 }),
      );
      const store = new AnalysisCacheStore({
        namespace: createLiminaArtifactNamespace({
          rootDir: f.root,
          generation: 0,
        }),
        configPath: f.config.configPath,
        identity: 'unused',
      });
      const snapshot = readStoredAnalysisSnapshot(store.path);
      const record = Object.values(snapshot.graphs)[0]!;
      const data = decodeData(record.data) as StoredGraphData;
      const fact = data.ownershipPlan.dependencyFacts[0]!;
      expect(fact.nativeEvidence).toBeDefined();
      switch (corruption) {
        case 'old-graph-key': {
          const key = Object.keys(snapshot.graphs)[0]!;
          delete snapshot.graphs[key];
          snapshot.graphs['generated-graph-declaration-governance-v8'] = record;
          break;
        }
        case 'forged-manifest-roots': {
          data.manifest.checkers.tsc!.roots = [];
          break;
        }
        case 'forged-manifest-targets': {
          data.manifest.targets.build = [];
          break;
        }
        case 'forged-manifest-owner': {
          const source = data.manifest.ownership.configs.find(
            (entry) => entry.role === 'type',
          )!;
          if (source.role === 'type') source.owner = 'tsgo';
          break;
        }
        case 'missing-root-member': {
          const root = data.checkerEntries.get('tsc')!;
          data.generatedFiles = new Map(data.generatedFiles).set(
            root,
            JSON.stringify({ references: [] }),
          );
          data.manifest.checkers.tsc!.roots = [];
          break;
        }
        case 'missing-coloring-inputs': {
          delete data.ownershipPlan.coloringInputs;
          break;
        }
        case 'forged-coloring-seed': {
          const seed = data.ownershipPlan
            .coloringInputs!.seeds.values()
            .next().value!;
          seed.localOwner = { kind: 'resolved', checker: 'tsgo' };
          break;
        }
        case 'missing-generated-reference':
        case 'extra-generated-reference':
        case 'redirected-generated-reference':
        case 'consistent-reference-removal': {
          const [file, content] = [...data.generatedFiles].find(
            ([file, text]) =>
              file.endsWith('.dts.json') &&
              JSON.parse(text).references?.length > 0,
          )!;
          const generated = JSON.parse(content);
          const previous = generated.references[0];
          if (corruption === 'extra-generated-reference')
            generated.references.push({ path: './foreign.dts.json' });
          else if (corruption === 'redirected-generated-reference')
            generated.references[0] = { path: './foreign.dts.json' };
          else generated.references = [];
          data.generatedFiles = new Map(data.generatedFiles).set(
            file,
            JSON.stringify(generated),
          );
          if (corruption === 'consistent-reference-removal') {
            const unit = data.governedSources
              .values()
              .flatMap((units) => units.values())
              .find(
                (source) =>
                  'dtsConfigPath' in source.buildProjection &&
                  source.buildProjection.dtsConfigPath === file,
              )!;
            unit.declarationReferences.clear();
            data.dependencyAnalysis.candidate = {
              ...data.dependencyAnalysis.candidate!,
              references: data.dependencyAnalysis.candidate!.references.filter(
                (pair) => pair.from !== unit.configPath,
              ),
            };
            expect(previous).toBeDefined();
          }
          break;
        }
        case 'foreign-target': {
          fact.physicalTargetPath = f.file('foreign.ts');
          break;
        }
        case 'missing-native-proof': {
          delete fact.nativeEvidence;
          break;
        }
        case 'missing-core-work': {
          data.dependencyAnalysis.outcome = {
            ...data.dependencyAnalysis.outcome!,
            core: { ...data.dependencyAnalysis.outcome!.core, entries: [] },
          };
          break;
        }
        default: {
          data.dependencyAnalysis.candidate = {
            configPaths: [],
            references: [],
            schedules: [],
          };
        }
      }
      record.data = encodeData(data);
      writeStoredAnalysisSnapshot(store.path, snapshot);
      const rejected = f.execute<GraphRunResult>(run);
      if (corruption !== 'old-graph-key')
        expect(rejected.events).toContainEqual(
          expect.objectContaining({
            kind: 'fallback-graph-dto-invalid',
            count: 1,
          }),
        );
      expect(rejected.events).not.toContainEqual(
        expect.objectContaining({ kind: 'graphHits', count: 1 }),
      );
      expect(rejected.events).toContainEqual(
        expect.objectContaining({ kind: 'semanticPrograms', count: 0 }),
      );
      expect(
        rejected.events.some(
          (event) => event.kind === 'restoredContexts' && event.count! > 0,
        ),
      ).toBe(true);
      expect(graphMeaning(rejected.graph)).toEqual(graphMeaning(first.graph));
      const recovered = f.execute<GraphRunResult>(run);
      expect(recovered.graph).toEqual(rejected.graph);
      expect(recovered.events).toContainEqual(
        expect.objectContaining({ kind: 'graphHits', count: 1 }),
      );
    },
  );

  it('physically stops a non-root implementation while the full Oracle loads its support and restores that boundary', () => {
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
    const run = 'console.log(JSON.stringify(await runCache()));';
    f.execute<GraphRunResult>(run);
    const warm = f.execute<GraphRunResult>(run);
    expect(warm.events).toContainEqual(
      expect.objectContaining({ kind: 'graphHits', count: 1 }),
    );
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
    const compatibility = f.execute<GraphRunResult>(run);
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
    const restored = f.execute<GraphRunResult>(run);
    expect(restored.graph).toEqual(compatibility.graph);
    expect(restored.events).toContainEqual(
      expect.objectContaining({ kind: 'graphHits', count: 1 }),
    );
    expect(restored.events).toContainEqual(
      expect.objectContaining({ kind: 'semanticPrograms', count: 0 }),
    );
    f.write(
      'src/value.d.ts',
      'import type {Value} from "../b/index";export interface V extends Value {}',
    );
    const recovered = f.execute<GraphRunResult>(run);
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
    expect(warm.events).toContainEqual(
      expect.objectContaining({ kind: 'graphHits', count: 1 }),
    );
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
    expect(recovered.events).toContainEqual(
      expect.objectContaining({ kind: 'graphHits', count: 1 }),
    );
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
    expect(warm.events).toContainEqual(
      expect.objectContaining({ kind: 'graphHits', count: 1 }),
    );
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
      expect(warm.events).toContainEqual(
        expect.objectContaining({ kind: 'graphHits', count: 1 }),
      );
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

  it('restores the graph and artifact authority before Program and keeps a strict clean snapshot unchanged', () => {
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
    const first = f.execute<GraphRunResult>(
      'console.log(JSON.stringify(await runCache()));',
    );
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
    expect(Object.keys(persisted!.graphs)).toHaveLength(1);
    expect(Object.values(persisted!.contexts)).toEqual(
      expect.arrayContaining([expect.objectContaining({ complete: true })]),
    );
    const mtime = statSync(store.path).mtimeMs;
    const next = f.execute<GraphRunResult>(
      'console.log(JSON.stringify(await runCache()));',
    );
    expect(next.graph).toEqual(first.graph);
    expect(next.events).toContainEqual(
      expect.objectContaining({ kind: 'graphHits', count: 1 }),
    );
    expect(next.events).toContainEqual(
      expect.objectContaining({ kind: 'semanticPrograms', count: 0 }),
    );
    expect(readFileSync(store.path)).toEqual(before);
    expect(statSync(store.path).mtimeMs).toBe(mtime);
    f.write(
      'src/a.ts',
      "\nimport type { V } from './value.js'; export type T = V;",
    );
    const changed = f.execute<GraphRunResult>(
      'console.log(JSON.stringify(await runCache()));',
    );
    expect(changed.graph.edges).toEqual(first.graph.edges);
    expect(changed.graph.manifest).toEqual(first.graph.manifest);
    expect(changed.events).toContainEqual(
      expect.objectContaining({ kind: 'resolverCalls', count: 0 }),
    );
    expect(
      changed.events.find((event) => event.kind === 'semanticPrograms')?.count,
    ).toBeGreaterThan(0);
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
    expect(forced.events).not.toContainEqual(
      expect.objectContaining({ kind: 'graphHits', count: 1 }),
    );
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
    expect(restored.events).toContainEqual(
      expect.objectContaining({ kind: 'graphHits', count: 1 }),
    );
    expect(restored.events).toContainEqual(
      expect.objectContaining({ kind: 'semanticPrograms', count: 0 }),
    );
    expect(readFileSync(store.path)).toEqual(refreshed);
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
    expect(result.events).toContainEqual(
      expect.objectContaining({ kind: 'graphHits', count: 1 }),
    );
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

function collectContextEnvironment(result: ReturnType<typeof analyze>) {
  return Object.values(result.cache.contexts)[0]?.environment.evidence;
}

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
    expect(warm.graph).toEqual(first.graph);
    expect(warm.events).toContainEqual(
      expect.objectContaining({ kind: 'graphHits', count: 1 }),
    );
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
    expect(selected.graph.edges.map((edge) => edge.toConfigPath)).toEqual([
      f.file('tsconfig.b2.json'),
    ]);
    const restored = f.execute<GraphRunResult>(run);
    expect(restored.graph).toEqual(selected.graph);
    expect(restored.events).toContainEqual(
      expect.objectContaining({ kind: 'graphHits', count: 1 }),
    );
  },
  60_000,
);

it('counts restored declaration candidates and revokes the last independent types contribution', () => {
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
  expect(warm.events).toContainEqual(
    expect.objectContaining({ kind: 'graphHits', count: 1 }),
  );
  expect(warm.events).toContainEqual(
    expect.objectContaining({
      name: 'declaration-candidate',
      kind: 'restore',
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
  expect(restored.events).toContainEqual(
    expect.objectContaining({ kind: 'graphHits', count: 1 }),
  );
}, 60_000);

it.each(['skipLibCheck', 'noCheck'] as const)(
  'revokes a restored external owner after enabling %s',
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
    f.execute<GraphRunResult>(run);
    const warm = f.execute<GraphRunResult>(run);
    expect(warm.events).toContainEqual(
      expect.objectContaining({ kind: 'graphHits', count: 1 }),
    );
    f.write(
      'tsconfig.b.json',
      JSON.stringify({
        ...b,
        compilerOptions: { ...compilerOptions, [option]: true },
      }),
    );
    const rejected = f.execute<{ error: string }>(
      'try { await runCache(); console.log(JSON.stringify({error:"not refused"})); } catch(error) { console.log(JSON.stringify({error:error.message})); }',
    );
    expect(rejected.error).toContain('owner must check declarations');
  },
  60_000,
);
