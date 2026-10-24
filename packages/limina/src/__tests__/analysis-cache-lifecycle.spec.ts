import type { AnalysisRead } from '#utils/analysis-input';
import { observeAnalysisRead, readAnalysisInput } from '#utils/analysis-input';
import { resolveExistingFilePath } from '#utils/module-resolution';
import { execFileSync } from 'node:child_process';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { glob } from 'tinyglobby';
import { afterEach, describe, expect, it } from 'vitest';
import { parseProjectConfigWithExtensions } from '../checker/project-base';
import { loadConfig } from '../config/loader';
import { EpochInputs } from '../core/analysis-cache/epoch-inputs';
import { NativeAnalysisCache } from '../core/analysis-cache/native-cache';
import { parseAnalysisSnapshot } from '../core/analysis-cache/snapshot-schema';
import type { GeneratedTsconfigGraphResult } from '../core/build-graph/types';
import { observeNativeFileIdentity } from '../core/typescript-semantic/native-file-identity';
import { readJsonFile } from '../core/workspace/package-manifest';
import { createLiminaArtifactNamespace } from '../domain/artifacts/namespace';
import { createArtifactPlan } from '../domain/artifacts/plan';
import { runExecutionTasks } from '../execution/executor';
import type { ExecutionTask } from '../execution/tasks';
import { taskId } from '../execution/tasks';
import { LiminaPreflightManager } from '../preflight';
import { AnalysisCacheController } from '../preflight/analysis-cache';
import { AnalysisCacheStore } from '../preflight/analysis-cache-store';
import { readStoredAnalysisSnapshot } from './helpers/analysis-snapshot';
import { withFixtureGovernanceRoot } from './helpers/governance-root';
import { createFixturePathResolver } from './helpers/path';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const temporary = mkdtempSync(path.join(tmpdir(), 'limina-cache-lifecycle-'));
  const rootDirectory = realpathSync(temporary);
  roots.push(rootDirectory);
  const file = createFixturePathResolver(rootDirectory);
  writeFileSync(file('package.json'), '{"name":"fixture","private":true}');
  writeFileSync(file('limina.config.mjs'), 'export default {};');
  const config = withFixtureGovernanceRoot({
    rootDir: rootDirectory,
    configPath: file('limina.config.mjs'),
  });
  const namespace = createLiminaArtifactNamespace({
    rootDir: rootDirectory,
    generation: 0,
  });
  return { path: file, rootDir: rootDirectory, config, namespace };
}

describe('glob discovery freshness', () => {
  function input(
    f: ReturnType<typeof fixture>,
    value: string[],
    kind: 'glob' | 'ts-directory' = 'glob',
  ): AnalysisRead {
    return {
      path: f.rootDir,
      key: 'workspace-glob',
      descriptor:
        kind === 'glob'
          ? {
              kind: 'glob',
              patterns: ['packages/*'],
              options: {
                absolute: true,
                cwd: f.rootDir,
                onlyDirectories: true,
                ignore: [],
              },
            }
          : {
              kind: 'ts-directory',
              arguments: [f.rootDir, null, null, null, null],
            },
      value,
      read: () => value,
    };
  }

  it('accepts reordered glob results during observation and final validation without mutating the reader', async () => {
    const f = fixture();
    const first = [f.path('packages/b'), f.path('packages/a')];
    const next = first.toReversed();
    const epoch = new EpochInputs();
    epoch.run(() =>
      observeAnalysisRead({ ...input(f, first), read: () => next }),
    );
    await expect(epoch.assertStable()).resolves.toBeUndefined();
    expect(() =>
      epoch.run(() => observeAnalysisRead(input(f, next))),
    ).not.toThrow();
    expect(first).toEqual([f.path('packages/b'), f.path('packages/a')]);
  });

  it('replays unordered persisted glob membership and still rejects added directories', async () => {
    const f = fixture();
    mkdirSync(f.path('packages/a'), { recursive: true });
    mkdirSync(f.path('packages/b'), { recursive: true });
    const epoch = new EpochInputs();
    const current = await glob('packages/*', {
      absolute: true,
      cwd: f.rootDir,
      onlyDirectories: true,
      ignore: [],
    });
    epoch.run(() => observeAnalysisRead(input(f, current.toReversed())));
    const saved = epoch.snapshot()!;
    await expect(new EpochInputs().validate(saved)).resolves.toBe(true);
    mkdirSync(f.path('packages/c'), { recursive: true });
    await expect(new EpochInputs().validate(saved)).resolves.toBe(false);
  });

  it('retains ordered non-glob observations and rejects removed glob members', async () => {
    const f = fixture();
    const first = [f.path('a.ts'), f.path('b.ts')];
    const ordered = new EpochInputs();
    ordered.run(() =>
      observeAnalysisRead({
        ...input(f, first, 'ts-directory'),
        read: () => first.toReversed(),
      }),
    );
    await expect(ordered.assertStable()).rejects.toThrow(
      'Analysis input changed during analysis',
    );
    const membership = new EpochInputs();
    membership.run(() =>
      observeAnalysisRead({
        ...input(f, first),
        read: () => first.slice(0, 1),
      }),
    );
    await expect(membership.assertStable()).rejects.toThrow(
      'Analysis input changed during analysis',
    );
  });
});

describe('replayed input freshness', () => {
  it('keeps physical identity receipts stable when installations add or remove hardlinks', async () => {
    const f = fixture();
    const file = f.path('lib.d.ts');
    const installed = f.path('installed.d.ts');
    writeFileSync(file, 'declare const value: string;');
    const epoch = new EpochInputs();
    const initial = epoch.run(() => observeNativeFileIdentity(file, 'fixed'));
    const saved = epoch.snapshot()!;

    linkSync(file, installed);
    await expect(epoch.assertStable()).resolves.toBeUndefined();
    expect(epoch.run(() => observeNativeFileIdentity(file, 'fixed'))).toEqual(
      initial,
    );
    await expect(new EpochInputs().validate(saved)).resolves.toBe(true);
    expect(new EpochInputs().validateSynchronous(saved)).toBe(true);

    unlinkSync(installed);
    await expect(epoch.assertStable()).resolves.toBeUndefined();
    await expect(new EpochInputs().validate(saved)).resolves.toBe(true);
  });

  it('rejects physical input byte edits with unchanged size and mtime and accepts restored bytes', async () => {
    const f = fixture();
    const file = f.path('lib.d.ts');
    const modified = new Date('2020-01-01T00:00:00Z');
    writeFileSync(file, 'declare const first: string;');
    utimesSync(file, modified, modified);
    const initial = statSync(file, { bigint: true });
    const epoch = new EpochInputs();
    epoch.run(() => observeNativeFileIdentity(file, 'fixed'));
    const saved = epoch.snapshot()!;

    writeFileSync(file, 'declare const other: string;');
    utimesSync(file, modified, modified);
    const changed = statSync(file, { bigint: true });
    expect(changed.ino).toBe(initial.ino);
    expect(changed.size).toBe(initial.size);
    expect(changed.mtimeNs).toBe(initial.mtimeNs);
    await expect(epoch.assertStable()).rejects.toThrow(
      'Analysis input changed during analysis',
    );
    await expect(new EpochInputs().validate(saved)).resolves.toBe(false);
    expect(new EpochInputs().validateSynchronous(saved)).toBe(false);

    writeFileSync(file, 'declare const first: string;');
    utimesSync(file, modified, modified);
    await expect(epoch.assertStable()).resolves.toBeUndefined();
    await expect(new EpochInputs().validate(saved)).resolves.toBe(true);
  });

  it.each(['synchronous', 'asynchronous'] as const)(
    'retains %s replay observations and rejects changes and conflicting live inputs',
    async (mode) => {
      const f = fixture();
      const file = f.path('input.ts');
      writeFileSync(file, 'export const value = 1;');
      const original = new EpochInputs();
      const observe = (epoch: EpochInputs) =>
        epoch.run(() =>
          readAnalysisInput(file, () => readFileSync(file, 'utf8')),
        );
      observe(original);
      const saved = original.snapshot()!;
      const canReplay = async (epoch: EpochInputs) =>
        mode === 'synchronous'
          ? epoch.validateSynchronous(saved)
          : epoch.validate(saved);
      const restored = new EpochInputs();
      expect(await canReplay(restored)).toBe(true);
      writeFileSync(file, 'export const value = 2;');
      await expect(restored.assertStable()).rejects.toThrow(
        'Analysis input changed during analysis',
      );
      expect(await canReplay(new EpochInputs())).toBe(false);
      const conflicting = new EpochInputs();
      observe(conflicting);
      writeFileSync(file, 'export const value = 1;');
      await expect(canReplay(conflicting)).rejects.toThrow(
        'Analysis input changed during analysis',
      );
    },
  );
});

describe('analysis transaction and publication', () => {
  it.each([
    ...([true, false, 'read-only'] as const).flatMap((analysisCache) =>
      ['module', 'declared', 'governance'].map((inputKind) => ({
        analysisCache,
        inputKind,
        cache: undefined,
        force: false,
      })),
    ),
    ...([true, 'read-only'] as const).flatMap((analysisCache) =>
      ['module', 'governance'].map((inputKind) => ({
        analysisCache,
        inputKind,
        cache: false,
        force: true,
      })),
    ),
  ])(
    'rejects $inputKind drift with caller $analysisCache, cache $cache and force $force',
    async ({ analysisCache, inputKind, cache, force }) => {
      const f = fixture();
      writeFileSync(
        f.path('policy.mjs'),
        'export default {pipelines: { first: [] }};',
      );
      writeFileSync(
        f.path('limina.config.mjs'),
        `import config from './policy.mjs'; export default {...config,${
          inputKind === 'declared'
            ? "cache:{dependencies:['./rules.json']}"
            : `cache:${String(cache)}`
        }};`,
      );
      writeFileSync(f.path('rules.json'), '{}');
      const driftPath = f.path(
        inputKind === 'module'
          ? 'policy.mjs'
          : inputKind === 'declared'
            ? 'rules.json'
            : 'package.json',
      );
      const driftContent =
        inputKind === 'governance'
          ? '{"name":"changed","private":true}'
          : 'export default {pipelines: { second: [] }};';
      const loader = new URL('../config/loader.ts', import.meta.url).href;
      const preflight = new URL('../preflight/manager.ts', import.meta.url)
        .href;
      writeFileSync(
        f.path('runner.mjs'),
        `
import {loadConfig} from ${JSON.stringify(loader)};
import {LiminaPreflightManager} from ${JSON.stringify(preflight)};
import {writeFileSync} from 'node:fs';
const config = await loadConfig(${JSON.stringify({ configPath: f.config.configPath, cwd: f.rootDir })});
const manager = new LiminaPreflightManager({config, analysisCache: ${JSON.stringify(analysisCache)}, forceAnalysisCache:${force}});
try {
  await manager.ensureGeneratedGraph();
  writeFileSync(${JSON.stringify(driftPath)}, ${JSON.stringify(driftContent)});
  let error;
  try { await manager.publishAnalysisCache(); } catch (caught) { error = caught.message; }
  console.log(JSON.stringify({error, pipelines: config.pipelines}));
} finally { manager.dispose(); }
`,
      );
      const output = execFileSync(
        process.execPath,
        [
          '--import',
          pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
          f.path('runner.mjs'),
        ],
        { encoding: 'utf8' },
      );
      expect(JSON.parse(output.trim())).toEqual({
        error: expect.stringContaining('Run the command again'),
        pipelines: { first: [] },
      });
    },
  );

  it('reparses effective configuration after drift and discards the old epoch', async () => {
    const f = fixture();
    writeFileSync(
      f.path('tsconfig.json'),
      '{"compilerOptions":{"strict":false}}',
    );
    const controller = new AnalysisCacheController(f.config, f.namespace);
    writeFileSync(f.path('a.ts'), 'export {};');
    let attempts = 0;
    const result = await controller.analyze({
      refresh: () => controller.refresh(),
      analyze: async () => {
        attempts += 1;
        const parsed = parseProjectConfigWithExtensions(
          { configPath: f.path('tsconfig.json'), projectRootDir: f.rootDir },
          [],
        );
        controller.cache.inputs.observeConfig(parsed.configClosure);
        if (attempts === 1)
          writeFileSync(
            f.path('tsconfig.json'),
            '{"compilerOptions":{"strict":true}}',
          );
        return parsed.options.strict;
      },
    });
    expect(result).toBe(true);
    expect(attempts).toBe(2);
    await controller.publish();
  });

  it('stops on Limina configuration drift and a new invocation loads the new binding', async () => {
    const f = fixture();
    const controller = new AnalysisCacheController(f.config, f.namespace);
    let retries = 0;
    await expect(
      controller.analyze({
        refresh: () => {
          retries += 1;
          controller.refresh();
        },
        analyze: async () => {
          writeFileSync(
            f.path('limina.config.mjs'),
            'export default {pipelines:{changed:[]}};',
          );
        },
      }),
    ).rejects.toThrow('Run the command again');
    expect(retries).toBe(0);
    const config = await loadConfig({
      configPath: f.config.configPath,
      cwd: f.rootDir,
    });
    expect(config.pipelines).toHaveProperty('changed');
    const next = new AnalysisCacheController(config, f.namespace);
    await expect(
      next.analyze({
        refresh: () => next.refresh(),
        analyze: async () => config.pipelines,
      }),
    ).resolves.toHaveProperty('changed');
  });

  it('bounds repeated drift and rejects a result from a replaced epoch', async () => {
    const f = fixture();
    writeFileSync(f.path('input'), '0');
    const controller = new AnalysisCacheController(f.config, f.namespace);
    let attempts = 0;
    await expect(
      controller.analyze({
        refresh: () => controller.refresh(),
        analyze: async () => {
          readAnalysisInput(f.path('input'), () =>
            readFileSync(f.path('input'), 'utf8'),
          );
          writeFileSync(f.path('input'), String(++attempts));
        },
      }),
    ).rejects.toThrow('Analysis input changed');
    expect(attempts).toBe(2);
    const waiting = Promise.withResolvers<void>();
    const late = controller.analyze({
      refresh: () => controller.refresh(),
      analyze: () => waiting.promise,
    });
    controller.refresh();
    waiting.resolve();
    await expect(late).rejects.toThrow('epoch was replaced');
  });

  it('preserves a newer snapshot revision and treats corrupted JSON as a miss', async () => {
    const f = fixture();
    const options = {
      namespace: f.namespace,
      identity: 'fixture',
      configPath: f.config.configPath,
      configVersion: 'fixture-config',
    };
    const first = new AnalysisCacheStore(options);
    const stale = new AnalysisCacheStore(options);
    expect(first.read()).toBeUndefined();
    expect(stale.read()).toBeUndefined();
    await first.publish(
      new NativeAnalysisCache('fixture', undefined, 'fixture-config'),
    );
    const published = readFileSync(first.path, 'utf8');
    await stale.publish(
      new NativeAnalysisCache('fixture', undefined, 'fixture-config'),
    );
    expect(readFileSync(first.path, 'utf8')).toBe(published);
    writeFileSync(first.path, '{broken');
    expect(first.read()).toBeUndefined();
    await first.publish(
      new NativeAnalysisCache('fixture', undefined, 'fixture-config'),
    );
    expect(storedSnapshot(first)).toBeDefined();
    expect(first.read()).toBeUndefined();
  });

  it('refreshes a snapshot after reading its physical baseline without restoring the model', async () => {
    const f = fixture();
    const options = {
      namespace: f.namespace,
      identity: 'fixture',
      configPath: f.config.configPath,
      configVersion: 'fixture-config',
    };
    const store = new AnalysisCacheStore(options);
    store.read();
    await store.publish(
      new NativeAnalysisCache('fixture', undefined, 'fixture-config'),
    );
    const previous = readFileSync(store.path);
    const refreshing = new AnalysisCacheStore(options);
    expect(refreshing.read({ restore: false })).toBeUndefined();
    expect(readFileSync(store.path)).toEqual(previous);
    await refreshing.publish(
      new NativeAnalysisCache('fixture', undefined, 'fixture-config'),
    );
    expect(readFileSync(store.path)).not.toEqual(previous);
    expect(storedSnapshot(refreshing)).toBeDefined();
  });

  it('does not publish after an observed runtime or discovery input changes', async () => {
    const f = fixture();
    const controller = new AnalysisCacheController(f.config, f.namespace);
    const directory = f.path('resources');
    mkdirSync(directory);
    writeFileSync(f.path('resources', 'style.css'), 'old');
    await controller.analyze({
      refresh: () => controller.refresh(),
      analyze: async () => {
        readAnalysisInput(f.path('resources', 'style.css'), () =>
          readFileSync(f.path('resources', 'style.css'), 'utf8'),
        );
      },
    });
    writeFileSync(f.path('resources', 'style.css'), 'new');
    await expect(controller.publish()).rejects.toThrow(
      'Analysis input changed',
    );
  });
});

it('does not replay a completed command or execution task when graph analysis retries', async () => {
  const f = fixture();
  writeFileSync(f.path('a.ts'), 'before');
  let analyses = 0;
  let taskRuns = 0;
  const preflight: LiminaPreflightManager = new LiminaPreflightManager({
    config: f.config,
    analysisCache: true,
    generatedGraphProvider: async () => {
      analyses += 1;
      readAnalysisInput(f.path('a.ts'), () =>
        readFileSync(f.path('a.ts'), 'utf8'),
      );
      if (analyses === 1) writeFileSync(f.path('a.ts'), 'after');
      return {
        changed: false,
        artifactPlan: createArtifactPlan(preflight.artifactNamespace, [], []),
      } as GeneratedTsconfigGraphResult;
    },
  });
  const command: ExecutionTask = {
    id: taskId('count'),
    label: 'count',
    kind: 'command',
    issueTask: 'command',
    generation: 0,
    order: 0,
    failPolicy: 'stop-pipeline',
    invalidatesPreflight: true,
    resources: {},
    run: async () => {
      execFileSync(process.execPath, [
        '-e',
        'require("node:fs").appendFileSync(process.argv[1], "run\\n")',
        f.path('count'),
      ]);
      return { status: 'passed', issues: [] };
    },
  };
  const analyze: ExecutionTask = {
    id: taskId('graph'),
    label: 'graph',
    kind: 'task',
    issueTask: 'graph:check',
    generation: 1,
    order: 1,
    after: [command.id],
    failPolicy: 'continue',
    resources: {},
    run: async () => {
      taskRuns += 1;
      await preflight.ensureGeneratedGraph();
      return { status: 'passed', issues: [] };
    },
  };
  try {
    const result = await runExecutionTasks({
      command: 'limina check fixture',
      rootDir: f.rootDir,
      preflight,
      tasks: [command, analyze],
    });
    expect(result.passed).toBe(true);
    expect(analyses).toBe(2);
    expect(taskRuns).toBe(1);
    expect(readFileSync(f.path('count'), 'utf8')).toBe('run\n');
  } finally {
    preflight.dispose();
  }
});

it('validates changed publication once per write boundary', async () => {
  const f = fixture();
  const input = f.path('input');
  writeFileSync(input, 'stable');
  const controller = new AnalysisCacheController(f.config, f.namespace);
  let reads = 0;
  await controller.analyze({
    refresh: () => controller.refresh(),
    analyze: async () => {
      readAnalysisInput(input, () => {
        reads += 1;
        return readFileSync(input, 'utf8');
      });
    },
  });
  reads = 0;
  await controller.publish();
  expect(reads).toBe(2);
  writeFileSync(input, 'drift');
  await expect(controller.publish()).rejects.toThrow('Analysis input changed');
  writeFileSync(input, 'stable');
});

it('rejects drift after temporary snapshot serialization and before atomic replacement', async () => {
  const f = fixture();
  const store = new AnalysisCacheStore({
    namespace: f.namespace,
    identity: 'fixture',
    configPath: f.config.configPath,
    configVersion: 'fixture-config',
  });
  const cache = new NativeAnalysisCache('fixture', undefined, 'fixture-config');
  writeFileSync(f.path('input'), 'first');
  cache.inputs.observe(f.path('input'), 'content');
  let validations = 0;
  await expect(
    store.publish(cache, () => {
      validations += 1;
      if (validations === 2) throw new Error('late configuration drift');
    }),
  ).rejects.toThrow('late configuration drift');
  expect(validations).toBe(2);
  expect(store.read()).toBeUndefined();
});

it('distinguishes content and existence observations of the same manifest', async () => {
  const f = fixture();
  const controller = new AnalysisCacheController(f.config, f.namespace);
  let retries = 0;
  const result = await controller.analyze({
    refresh: () => {
      retries += 1;
      controller.refresh();
    },
    analyze: async () => ({
      manifest: readJsonFile(f.path('package.json')),
      target: resolveExistingFilePath(f.path('package.json')),
    }),
  });
  expect(result).toEqual({
    manifest: { name: 'fixture', private: true },
    target: f.path('package.json'),
  });
  expect(retries).toBe(0);
  await controller.publish();
});

it('rejects governance changes during config evaluation and the creation of a nearer root', async () => {
  const f = fixture();
  writeFileSync(
    f.path('limina.config.mjs'),
    `import {writeFileSync} from 'node:fs';
writeFileSync(new URL('./package.json',import.meta.url),'${JSON.stringify({ name: 'changed', private: true })}');
export default {};`,
  );
  await expect(
    loadConfig({
      configPath: f.config.configPath,
      cwd: f.rootDir,
    }),
  ).rejects.toThrow('Run the command again');
  mkdirSync(f.path('nested'));
  writeFileSync(f.path('nested/limina.config.mjs'), 'export default {};');
  const nested = await loadConfig({
    configPath: f.path('nested/limina.config.mjs'),
    cwd: f.rootDir,
  });
  const controller = new AnalysisCacheController(nested, f.namespace);
  writeFileSync(
    f.path('nested/package.json'),
    '{"name":"nearer","private":true}',
  );
  await expect(
    controller.analyze({
      refresh: () => controller.refresh(),
      analyze: async () => {},
    }),
  ).rejects.toThrow('Run the command again');
});

it.each(['incompatible', 'corrupt', 'forced'] as const)(
  'keeps a physical CAS baseline for %s snapshots',
  async (baseline) => {
    const f = fixture();
    const options = {
      namespace: f.namespace,
      configPath: f.config.configPath,
      configVersion: 'fixture-config',
      identity: 'old-tools',
    };
    const seed = new AnalysisCacheStore(options);
    seed.read();
    await seed.publish(
      new NativeAnalysisCache('old-tools', undefined, 'fixture-config'),
    );
    if (baseline === 'corrupt') writeFileSync(seed.path, '{broken');
    const staleIdentity = baseline === 'forced' ? 'old-tools' : 'new-tools';
    const stale = new AnalysisCacheStore({
      ...options,
      identity: staleIdentity,
    });
    expect(stale.read({ restore: baseline !== 'forced' })).toBeUndefined();
    const current = new AnalysisCacheStore({
      ...options,
      identity: 'other-tools',
    });
    current.read();
    await current.publish(
      new NativeAnalysisCache('other-tools', undefined, 'fixture-config'),
    );
    const published = readFileSync(seed.path, 'utf8');
    await stale.publish(
      new NativeAnalysisCache(staleIdentity, undefined, 'fixture-config'),
    );
    expect(readFileSync(seed.path, 'utf8')).toBe(published);
  },
);

it('propagates a late observation failure even when it has a filesystem error code', async () => {
  const f = fixture();
  const store = new AnalysisCacheStore({
    namespace: f.namespace,
    configPath: f.config.configPath,
    configVersion: 'fixture-config',
    identity: 'fixture',
  });
  store.read();
  let checks = 0;
  await expect(
    store.publish(
      new NativeAnalysisCache('fixture', undefined, 'fixture-config'),
      () => {
        checks += 1;
        if (checks === 2)
          throw Object.assign(new Error('observed module became unreadable'), {
            code: 'EACCES',
          });
      },
    ),
  ).rejects.toThrow('observed module became unreadable');
  expect(checks).toBe(2);
  expect(store.read()).toBeUndefined();
});

it('does not equate physically different corrupt snapshot bytes after UTF-8 replacement', async () => {
  const f = fixture();
  const store = new AnalysisCacheStore({
    namespace: f.namespace,
    configPath: f.config.configPath,
    configVersion: 'fixture-config',
    identity: 'fixture',
  });
  store.read();
  await store.publish(
    new NativeAnalysisCache('fixture', undefined, 'fixture-config'),
  );
  const before = Buffer.from([0xff]);
  const after = Buffer.from([0xfe]);
  expect(before.toString('utf8')).toBe(after.toString('utf8'));
  writeFileSync(store.path, before);
  expect(store.read()).toBeUndefined();
  writeFileSync(store.path, after);
  await store.publish(
    new NativeAnalysisCache('fixture', undefined, 'fixture-config'),
  );
  expect(readFileSync(store.path)).toEqual(after);
});

it('rejects incompatible root metadata before reading ordinary model fields', () => {
  const snapshot = new NativeAnalysisCache(
    'fixture',
    undefined,
    'second',
  ).snapshot();
  expect(parseAnalysisSnapshot(snapshot, 'fixture', 'second')).toBeDefined();
  const unconsumed = Object.defineProperty(
    { header: snapshot.header },
    'inputs',
    {
      get: () => {
        throw new Error('Old scope records must not be consumed.');
      },
    },
  );
  expect(
    parseAnalysisSnapshot(unconsumed, 'fixture', 'different'),
  ).toBeUndefined();
  for (const configModules of [
    undefined,
    {
      ...snapshot.configModules,
      complete: false,
      otherUnknownReasons: ['custom-loader-unobserved'],
    },
    {
      ...snapshot.configModules,
      complete: true,
      otherUnknownReasons: ['custom-loader-unobserved'],
    },
  ]) {
    const blocked = Object.defineProperty(
      { header: snapshot.header, configModules },
      'inputs',
      {
        get: () => {
          throw new Error(
            'Incomplete config must reject before adopting ordinary inputs.',
          );
        },
      },
    );
    expect(parseAnalysisSnapshot(blocked, 'fixture', 'second')).toBeUndefined();
  }
});

function storedSnapshot(store: AnalysisCacheStore) {
  return parseAnalysisSnapshot(
    readStoredAnalysisSnapshot(store.path),
    store.identity,
  );
}
