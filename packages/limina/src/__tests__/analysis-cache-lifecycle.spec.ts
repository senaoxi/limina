import { readAnalysisInput } from '#utils/analysis-input';
import { resolveExistingFilePath } from '#utils/module-resolution';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseProjectConfigWithExtensions } from '../checker/project-base';
import { loadConfig } from '../config/loader';
import { NativeAnalysisCache } from '../core/analysis-cache/native-cache';
import { parseAnalysisSnapshot } from '../core/analysis-cache/snapshot-schema';
import type { GeneratedTsconfigGraphResult } from '../core/build-graph/types';
import { readJsonFile } from '../core/workspace/package-manifest';
import { createLiminaArtifactNamespace } from '../domain/artifacts/namespace';
import { createArtifactPlan } from '../domain/artifacts/plan';
import { runExecutionTasks } from '../execution/executor';
import { type ExecutionTask, taskId } from '../execution/tasks';
import { LiminaPreflightManager } from '../preflight';
import { AnalysisCacheController } from '../preflight/analysis-cache';
import { AnalysisCacheStore } from '../preflight/analysis-cache-store';
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

describe('analysis transaction and publication', () => {
  it.each([true, false, 'read-only'] as const)(
    'rejects observed configuration drift after analysis with cache mode %s',
    async (analysisCache) => {
      const f = fixture();
      writeFileSync(
        f.path('policy.mjs'),
        'export default { pipelines: { first: [] } };',
      );
      writeFileSync(
        f.path('limina.config.mjs'),
        'export { default } from "./policy.mjs";',
      );
      const loader = fileURLToPath(
        new URL('../config/loader.ts', import.meta.url),
      );
      const preflight = fileURLToPath(
        new URL('../preflight/manager.ts', import.meta.url),
      );
      writeFileSync(
        f.path('runner.mjs'),
        `
import {loadConfig} from ${JSON.stringify(loader)};
import {LiminaPreflightManager} from ${JSON.stringify(preflight)};
import {writeFileSync} from 'node:fs';
const config = await loadConfig(${JSON.stringify({ configPath: f.config.configPath, cwd: f.rootDir })});
const manager = new LiminaPreflightManager({config, analysisCache: ${JSON.stringify(analysisCache)}});
try {
  await manager.ensureGeneratedGraph();
  writeFileSync(${JSON.stringify(f.path('policy.mjs'))}, 'export default { pipelines: { second: [] } };');
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
          createRequire(import.meta.url).resolve('tsx'),
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
    expect(first.read()).toBeDefined();
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

it.each(['incompatible', 'corrupt'] as const)(
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
    const stale = new AnalysisCacheStore({ ...options, identity: 'new-tools' });
    expect(stale.read()).toBeUndefined();
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
      new NativeAnalysisCache('new-tools', undefined, 'fixture-config'),
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

it('checks root configuration metadata before adopting any previous model records', async () => {
  const f = fixture();
  const options = {
    namespace: f.namespace,
    configPath: f.config.configPath,
    identity: 'fixture',
    configVersion: 'first',
  };
  const seed = new AnalysisCacheStore(options);
  seed.read();
  await seed.publish(new NativeAnalysisCache('fixture', undefined, 'first'));
  const previous = seed.read()!;
  const skipped = new NativeAnalysisCache('fixture', previous, 'second');
  expect(skipped.previous).toBeUndefined();
  expect(skipped.inputs.records).toEqual({});
  expect(skipped.contributions.records).toEqual({});
  const unknown = new NativeAnalysisCache('fixture', previous);
  expect(unknown.previous).toBeUndefined();
  const changed = new AnalysisCacheStore({
    ...options,
    configVersion: 'second',
  });
  expect(changed.read()).toBeUndefined();
  await changed.publish(skipped);
  expect(changed.read()?.header.configVersion).toBe('second');
  const snapshot = changed.read()!;
  for (const header of [
    { ...snapshot.header, schema: 2 },
    { ...snapshot.header, configVersion: undefined },
    { ...snapshot.header, configVersion: null },
  ]) {
    writeFileSync(changed.path, JSON.stringify({ ...snapshot, header }));
    expect(changed.read()).toBeUndefined();
    await changed.publish(
      new NativeAnalysisCache('fixture', undefined, 'second'),
    );
    expect(changed.read()?.header.schema).toBe(3);
  }
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
});
