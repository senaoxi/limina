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
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseProjectConfigWithExtensions } from '../checker/project-base';
import { loadConfig } from '../config/loader';
import { NativeAnalysisCache } from '../core/analysis-cache/native-cache';
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
    };
    const first = new AnalysisCacheStore(options);
    const stale = new AnalysisCacheStore(options);
    expect(first.read()).toBeUndefined();
    expect(stale.read()).toBeUndefined();
    await first.publish(new NativeAnalysisCache('fixture'));
    const published = readFileSync(first.path, 'utf8');
    await stale.publish(new NativeAnalysisCache('fixture'));
    expect(readFileSync(first.path, 'utf8')).toBe(published);
    writeFileSync(first.path, '{broken');
    expect(first.read()).toBeUndefined();
    await first.publish(new NativeAnalysisCache('fixture'));
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
  });
  const cache = new NativeAnalysisCache('fixture');
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
  const config = await loadConfig({
    configPath: f.config.configPath,
    cwd: f.rootDir,
  });
  expect(() => new AnalysisCacheController(config, f.namespace)).toThrow(
    'Run the command again',
  );
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
