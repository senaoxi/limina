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
import { afterEach, describe, expect, it } from 'vitest';
import { parseTypeScriptCommandLine } from '../checker/project-base';
import {
  captureInvocationData,
  invocationDataVersion,
} from '../config/invocation-data';
import { getActiveCheckers } from '../config/runtime';
import { directoryFingerprint } from '../core/analysis-cache/directory-fingerprint';
import { NativeAnalysisCache } from '../core/analysis-cache/native-cache';
import { parseAnalysisSnapshot } from '../core/analysis-cache/snapshot-schema';
import { createBoundedTypeScriptSemanticContext } from '../core/typescript-semantic/context';
import type { TypeScriptSemanticProject } from '../core/typescript-semantic/contracts';
import { createWorkspaceSourceBoundary } from '../core/typescript-semantic/workspace-source-boundary';
import { createLiminaArtifactNamespace } from '../domain/artifacts/namespace';
import { LiminaPreflightManager } from '../preflight';
import { AnalysisCacheStore } from '../preflight/analysis-cache-store';
import { withFixtureGovernanceRoot } from './helpers/governance-root';
import { createFixturePathResolver } from './helpers/path';

const roots: string[] = [];
afterEach(() => {
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
    'export default {config:{checkers:{tsc:{include:["tsconfig.json"]}}}};',
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
    config: { checkers: { tsc: { include: ['tsconfig.json'] } } },
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
      admissionMode: 'full-program',
      configPath: file(name),
      fileNames: parsed.fileNames,
      options: parsed.options,
      projectReferences: parsed.projectReferences,
      workspaceSourceBoundary: createWorkspaceSourceBoundary(parsed.fileNames),
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
    return {graph:{manifest:graph.manifest,ownershipPlan:graph.ownershipPlan},events,isPassed};
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
      { encoding: 'utf8' },
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
      expect(dirty.facts).toEqual(analyze(project).facts);
      rmSync(f.file('src/package.json'));
      expect(analyze(project, dirty.cache).facts).toEqual(first.facts);
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
    expect(next.cache.inputs.domainDirty).toBe(true);
  });
});

describe('R01 effective local metadata and installation trust', () => {
  it.each([false, true])(
    'restores a shared pnpm member without scanning installed roots (explicit roots: %s)',
    (explicitRoots) => {
      const f = fixture();
      f.write(
        'package.json',
        '{"private":true,"packageManager":"pnpm@11.28.3"}',
      );
      rmSync(f.file('package-lock.json'));
      f.write('pnpm-workspace.yaml', 'packages: [packages/*]\n');
      f.write(
        'pnpm-lock.yaml',
        'lockfileVersion: 9\nimporters:\n  .: {}\n  packages/member: {}\n',
      );
      f.write(
        'node_modules/.modules.yaml',
        'packageManager: pnpm@11.28.3\nvirtualStoreDir: .pnpm\n',
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
      f.write('pnpm-lock.yaml', 'lockfileVersion: 9\nimporters:\n  .: {}\n');
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

  it('preserves an unchanged snapshot when unknown installation coverage rebuilds the Program but facts hit', () => {
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
    expect(warm.cache.metrics.factHits).toBeGreaterThan(0);
    expect(warm.facts).toEqual(first.facts);
    const { header: _header, ...previousRecords } = warm.cache.previous!;
    expect(warm.cache.snapshotRecords()).toStrictEqual(previousRecords);
    expect(warm.cache.isUnchanged()).toBe(true);
    expect(warm.cache.snapshot()).toBe(warm.cache.previous);
    expect(warm.cache.metrics.snapshotClones ?? 0).toBe(0);
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

  it('invalidates all configurations on a related lock change and records trusted installation evidence', () => {
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
    expect(next.cache.inputs.domainDirty).toBe(true);
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
      `export default {
      config:{checkers:{tsc:{include:['tsconfig.json']}}},
      graph:{rules:{runtime:process.env.LIMINA_CONFIG_DENIED === 'yes' ? {deny:{deps:[{name:'node:*',reason:'runtime policy'}]}} : {}}}
    };`,
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
    expect(
      changed.events.find((event) => event.kind === 'factQueries')?.count,
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
          : 'import { policy } from "./policy.mjs"; export default { pipelines: { [policy]: [] } };',
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
        config: {
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
  graph: { manifest: unknown; ownershipPlan: unknown };
  events: { name?: string; kind?: string; count?: number }[];
  isPassed: boolean;
}

describe('production graph snapshots and publication', () => {
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
        `export default Object.defineProperty({config:{checkers:{tsc:{include:["tsconfig.json"]}}}}, 'cache', {value:false,enumerable:${enumerable}});`,
      );
      for (const isForced of [false, true]) {
        const result = f.execute<GraphRunResult>(
          `console.log(JSON.stringify(await runCache({cache:${JSON.stringify(mode)},force:${isForced}})));`,
        );
        expect(result.graph).toEqual(seed.graph);
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
    const persisted = JSON.parse(before.toString());
    expect(
      parseAnalysisSnapshot(persisted, persisted.header.identity),
    ).toBeDefined();
    expect(Object.keys(persisted.graphs)).toEqual(['generated-graph-v1']);
    expect(Object.values(persisted.contexts)).toEqual(
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
    expect(forced.graph).toEqual(seed.graph);
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
