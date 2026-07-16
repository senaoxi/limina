import type { ResolvedLiminaConfig } from '#config/runner';
import { createAnalysisProviders } from '#core';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createCheckRunRecorder } from '../check-reporting/run-recorder';
import {
  readCheckIssueSnapshot,
  writeNotRunCheckIssueSnapshot,
} from '../check-reporting/snapshot';
import { createLiminaArtifactNamespace } from '../domain/artifacts/namespace';
import { ResourceLockSet } from '../execution/resources';
import { createLiminaCheckFlowReporter, LiminaFlowReporter } from '../flow';
import {
  createDefaultExecutionPlan,
  createExecutionPlan,
  describePipeline,
  normalizePipelineStep,
  runDefaultCheck,
  runPipeline,
} from '../pipeline/runner';
import { LiminaPreflightManager } from '../preflight/manager';

const green = (message: string): string => `\u001B[32m${message}\u001B[0m`;

describe('ExecutionPlan construction', () => {
  it('inserts one generation-specific materializer per filesystem segment', async () => {
    const fixture = await createConfig();
    fixture.config.pipelines = {
      demo: [
        'checker:build',
        { command: 'command-a', type: 'command' },
        'checker:typecheck',
        { command: 'command-b', type: 'command' },
        'checker:build',
      ],
    };

    try {
      const plan = createExecutionPlan(fixture.config, 'demo');
      expect(
        plan.tasks.map(({ generation, kind, label }) => ({
          generation,
          kind,
          label,
        })),
      ).toEqual([
        { generation: 0, kind: 'preparation', label: 'workspace:validate' },
        { generation: 0, kind: 'preparation', label: 'graph:materialize' },
        { generation: 0, kind: 'task', label: 'checker:build' },
        { generation: 0, kind: 'command', label: 'command-a' },
        { generation: 1, kind: 'preparation', label: 'workspace:validate' },
        { generation: 1, kind: 'preparation', label: 'graph:materialize' },
        { generation: 1, kind: 'task', label: 'checker:typecheck' },
        { generation: 1, kind: 'command', label: 'command-b' },
        { generation: 2, kind: 'preparation', label: 'workspace:validate' },
        { generation: 2, kind: 'preparation', label: 'graph:materialize' },
        { generation: 2, kind: 'task', label: 'checker:build' },
      ]);
      const materializers = plan.tasks.filter(
        (task) => task.issueTask === 'graph:materialize',
      );
      expect(new Set(materializers.map((task) => task.id)).size).toBe(3);
      for (const checker of plan.tasks.filter((task) =>
        task.issueTask.startsWith('checker:'),
      )) {
        expect(checker.requiresSuccessOf).toHaveLength(1);
        expect(
          plan.tasks.find((task) => task.id === checker.requiresSuccessOf?.[0])
            ?.generation,
        ).toBe(checker.generation);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('shares one materializer across default build and typecheck tasks', async () => {
    const fixture = await createConfig();
    try {
      const plan = createDefaultExecutionPlan(fixture.config);
      const materializer = plan.tasks.filter(
        (task) => task.issueTask === 'graph:materialize',
      );
      expect(materializer).toHaveLength(1);
      expect(
        plan.tasks
          .filter((task) => task.issueTask.startsWith('checker:'))
          .map((task) => task.requiresSuccessOf),
      ).toEqual([[materializer[0]!.id], [materializer[0]!.id]]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects empty named pipelines before any execution object exists', async () => {
    const fixture = await createConfig();
    fixture.config.pipelines = { demo: [] };
    try {
      expect(() => createExecutionPlan(fixture.config, 'demo')).toThrow(
        'Pipeline "demo" must contain at least one step.',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps labels separate from stable task and issue identities', async () => {
    const fixture = await createConfig();
    fixture.config.pipelines = {
      demo: [
        { args: ['--flag'], command: 'custom-script', type: 'command' },
        { args: ['--flag'], command: 'custom-script', type: 'command' },
      ],
    };
    try {
      const commands = createExecutionPlan(fixture.config, 'demo').tasks;
      expect(commands.map((task) => task.label)).toEqual([
        'custom-script --flag',
        'custom-script --flag',
      ]);
      expect(commands.map((task) => task.issueTask)).toEqual([
        'command',
        'command',
      ]);
      expect(commands[0]!.id).not.toBe(commands[1]!.id);
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses repository and manifest barriers conservatively', async () => {
    const fixture = await createConfig();
    fixture.config.pipelines = {
      demo: [
        'source:check',
        'checker:build',
        'graph:prepare',
        'package:check',
        { command: 'unknown-command', type: 'command' },
      ],
    };
    try {
      const plan = createExecutionPlan(fixture.config, 'demo');
      const source = plan.tasks.find(
        (task) => task.issueTask === 'source:check',
      )!;
      const otherRepositoryTasks = plan.tasks.filter(
        (task) => task.kind !== 'command' && task.issueTask !== 'source:check',
      );
      expect(source.resources.read).toContain('repository:snapshot');
      expect(source.resources.write).toContain('workspace:manifest');
      for (const task of otherRepositoryTasks) {
        expect(task.resources.read).toContain('repository:snapshot');
        expect(task.resources.read).toContain('workspace:manifest');
      }
      const graphPrepare = plan.tasks.find(
        (task) => task.issueTask === 'graph:prepare',
      )!;
      expect(graphPrepare.resources.write ?? []).not.toContain(
        'workspace:generated-files',
      );

      const locks = new ResourceLockSet();
      locks.acquire(source.id, source.resources);
      for (const task of otherRepositoryTasks) {
        expect(locks.canAcquire(task.resources)).toBe(false);
      }
      const command = plan.tasks.find((task) => task.kind === 'command')!;
      expect(locks.canAcquire(command.resources)).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });
});

async function createConfig(): Promise<{
  cleanup: () => Promise<void>;
  config: ResolvedLiminaConfig;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-pipeline-')),
  );
  const configPath = path.join(rootDir, 'limina.config.mjs');

  await writeFile(configPath, 'export default {};\n');
  await writeText(
    path.join(rootDir, 'package.json'),
    stringifyJson({ name: 'fixture', private: true }),
  );
  await writeText(path.join(rootDir, 'pnpm-workspace.yaml'), 'packages: []\n');

  return {
    cleanup: async () => {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    },
    config: {
      configPath,
      rootDir,
    },
  };
}

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const buildCompilerOptions = {
  composite: true,
  declaration: true,
  emitDeclarationOnly: true,
  incremental: true,
  module: 'ESNext',
  moduleResolution: 'bundler',
  noEmit: false,
  outDir: './.tsbuild',
  strict: true,
  target: 'ES2023',
  types: [],
};

async function createPassingCheckPipelineConfig(): Promise<{
  cleanup: () => Promise<void>;
  config: ResolvedLiminaConfig;
}> {
  const fixture = await createConfig();
  const rootDir = fixture.config.rootDir;

  await writeText(
    path.join(rootDir, 'package.json'),
    stringifyJson({
      name: 'fixture',
      private: true,
    }),
  );
  await writeText(
    path.join(rootDir, 'pnpm-workspace.yaml'),
    'packages:\n  - packages/*\n',
  );
  await writeText(
    path.join(rootDir, 'packages/app/package.json'),
    stringifyJson({
      exports: {
        '.': './src/index.ts',
      },
      name: '@fixture/app',
      scripts: {
        build: 'limina build tsconfig.json',
      },
      type: 'module',
      version: '1.0.0',
    }),
  );
  await writeText(
    path.join(rootDir, 'packages/app/src/index.ts'),
    'export const value = 1;\n',
  );
  await writeText(
    path.join(rootDir, 'node_modules/typescript/package.json'),
    stringifyJson({
      name: 'typescript',
      version: '0.0.0-fixture',
    }),
  );
  await writeText(
    path.join(rootDir, 'node_modules/.bin/tsc'),
    '#!/usr/bin/env sh\nexit 0\n',
  );
  await chmod(path.join(rootDir, 'node_modules/.bin/tsc'), 0o755);
  await writeText(
    path.join(rootDir, 'node_modules/.bin/tsc.cmd'),
    '@ECHO OFF\r\nEXIT /B 0\r\n',
  );
  await writeText(
    path.join(rootDir, 'packages/app/tsconfig.json'),
    stringifyJson({
      liminaOptions: {
        outputs: {},
      },
      compilerOptions: buildCompilerOptions,
      include: ['src/**/*.ts'],
    }),
  );
  await writeText(
    path.join(rootDir, 'tsconfig.json'),
    stringifyJson({
      files: [],
      references: [{ path: './packages/app/tsconfig.json' }],
    }),
  );

  fixture.config.config = {
    checkers: {
      typescript: {
        include: ['tsconfig.json', '**/tsconfig.json'],
        preset: 'tsc',
      },
    },
    source: {
      include: ['packages/app/src/**/*.ts'],
    },
  };
  fixture.config.source = {
    knip: false,
  };
  fixture.config.pipelines = {
    demo: ['graph:check', 'source:check', 'proof:check', 'checker:build'],
  };

  return fixture;
}

async function createOutputPackage(
  rootDir: string,
  packageName: string,
  source: string,
): Promise<string> {
  const packageDirName = packageName.split('/').at(-1) ?? packageName;
  const outDir = path.join(rootDir, 'packages', packageDirName, 'dist');

  await writeText(
    path.join(outDir, 'package.json'),
    JSON.stringify({
      dependencies: {
        '@example/dep': '1.0.0',
      },
      exports: {
        '.': './index.js',
      },
      name: packageName,
    }),
  );
  await writeText(path.join(outDir, 'index.js'), source);
  await writeText(path.join(outDir, 'README.md'), '# Example package\n');
  await writeText(path.join(outDir, 'LICENSE.md'), 'MIT\n');

  return path.relative(rootDir, outDir);
}

function createFlow(): {
  chunks: string[];
  flow: LiminaFlowReporter;
} {
  const chunks: string[] = [];

  return {
    chunks,
    flow: new LiminaFlowReporter({
      env: {
        CI: 'true',
      },
      forceTty: false,
      output: {
        write: (message) => {
          chunks.push(message);
        },
      },
      stdout: {
        isTTY: false,
      },
    }),
  };
}

function createTtyFlow(): {
  chunks: string[];
  flow: LiminaFlowReporter;
} {
  const chunks: string[] = [];
  const stdout = {
    columns: 120,
    isTTY: true,
    write: (message: string | Uint8Array) => {
      chunks.push(
        message instanceof Uint8Array
          ? Buffer.from(message).toString()
          : message,
      );
      return true;
    },
  };

  return {
    chunks,
    flow: new LiminaFlowReporter({
      env: {},
      forceTty: true,
      stdout,
    }),
  };
}

function createCheckTtyFlow(): {
  chunks: string[];
  flow: LiminaFlowReporter;
} {
  const chunks: string[] = [];
  const stdout = {
    columns: 120,
    isTTY: true,
    write: (message: string | Uint8Array) => {
      chunks.push(
        message instanceof Uint8Array
          ? Buffer.from(message).toString()
          : message,
      );
      return true;
    },
  };

  return {
    chunks,
    flow: createLiminaCheckFlowReporter({
      env: {},
      forceTty: true,
      stdout,
    }),
  };
}

describe('runPipeline', () => {
  it('recognizes source:check as a built-in task', () => {
    expect(normalizePipelineStep('source:check')).toEqual({
      name: 'source:check',
      type: 'task',
    });
  });

  it('recognizes checker:typecheck as a built-in task', () => {
    expect(normalizePipelineStep('checker:typecheck')).toEqual({
      name: 'checker:typecheck',
      type: 'task',
    });
  });

  it('recognizes release:check as a built-in task', () => {
    expect(normalizePipelineStep('release:check')).toEqual({
      name: 'release:check',
      type: 'task',
    });
  });

  it('does not recognize removed task orchestrator checks as built-in tasks', () => {
    expect(normalizePipelineStep('nx:check')).toEqual({
      args: [],
      command: 'nx:check',
      type: 'command',
    });
  });

  it('reports missing user pipeline config with a config hint', async () => {
    const fixture = await createConfig();

    try {
      await expect(runPipeline(fixture.config, 'missing')).rejects.toThrow(
        /Pipeline instruction "missing" was not found\.\nDefine it in limina\.config\.mjs under the "pipelines" field/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('runs the built-in default check pipeline without configured pipelines', async () => {
    const fixture = await createConfig();
    const { chunks, flow } = createFlow();

    fixture.config.config = {
      checkers: {
        svelte: {
          include: ['tsconfig.svelte.json'],
          preset: 'svelte-check',
        },
        typescript: {
          include: ['tsconfig.json'],
          preset: 'tsc',
        },
      },
    };

    try {
      await expect(runDefaultCheck(fixture.config, { flow })).resolves.toBe(
        false,
      );

      expect(
        chunks.some((chunk) => chunk.includes('[start] default check')),
      ).toBe(true);
      expect(
        chunks.some((chunk) =>
          chunk.includes('first-class build execution: typescript (tsc)'),
        ),
      ).toBe(true);
      expect(
        chunks.some((chunk) =>
          chunk.includes(
            'second-class typecheck execution: svelte (svelte-check)',
          ),
        ),
      ).toBe(true);
      expect(
        chunks.some((chunk) =>
          chunk.includes('source graph: typescript (tsc)'),
        ),
      ).toBe(true);
      expect(
        chunks.some((chunk) =>
          chunk.includes('no source graph: svelte (svelte-check)'),
        ),
      ).toBe(true);
      expect(
        chunks.some((chunk) => chunk.includes('[start] graph check')),
      ).toBe(true);
      expect(
        chunks.some((chunk) =>
          chunk.includes('[fail] default check finished with failures'),
        ),
      ).toBe(true);
      expect(
        chunks.some((chunk) => chunk.includes('[start] checker build')),
      ).toBe(true);
      expect(chunks.some((chunk) => chunk.includes('[skip] skipped:'))).toBe(
        false,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('renders default check task tree before auto checker discovery resolves', async () => {
    const fixture = await createConfig();
    const { chunks, flow } = createTtyFlow();
    let rejectGeneratedGraph: ((error: Error) => void) | undefined;
    const generatedGraph = new Promise<GeneratedTsconfigGraphResult>(
      (_resolve, reject) => {
        rejectGeneratedGraph = reject;
      },
    );
    const generatedGraphProvider = vi.fn(() => generatedGraph);

    try {
      const check = runDefaultCheck(fixture.config, {
        flow,
        generatedGraphProvider,
      });

      expect(chunks.join('')).toContain('◇      graph check\n');
      expect(chunks.join('')).toContain('◇      source check\n');
      expect(chunks.join('')).toContain('◇      proof check\n');
      expect(chunks.join('')).toContain('◇      checker build\n');
      expect(chunks.join('')).toContain('◇      checker typecheck\n');

      await vi.waitFor(() => {
        expect(generatedGraphProvider).toHaveBeenCalledTimes(1);
      });
      rejectGeneratedGraph?.(new Error('delayed generated graph'));

      await expect(check).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('passes all command steps in order', async () => {
    const fixture = await createConfig();
    const { chunks, flow } = createFlow();

    fixture.config.pipelines = {
      demo: [
        {
          args: ['-e', 'process.exit(0)'],
          command: process.execPath,
          type: 'command',
        },
        {
          args: ['-e', 'process.exit(0)'],
          command: process.execPath,
          type: 'command',
        },
      ],
    };

    try {
      await expect(runPipeline(fixture.config, 'demo', { flow })).resolves.toBe(
        true,
      );

      expect(
        chunks.some((chunk) => chunk.includes('[pass] pipeline: demo')),
      ).toBe(true);
      expect(
        chunks.filter((chunk) => chunk.includes('[pass] command:')).length,
      ).toBe(2);
    } finally {
      await fixture.cleanup();
    }
  });

  it('shares generated graph preflight between built-in tasks', async () => {
    const fixture = await createConfig();
    let preflight: LiminaPreflightManager;
    const generatedGraphProvider = vi.fn(() =>
      preflight.providers.buildGraph.getGraph(),
    );
    preflight = new LiminaPreflightManager({
      config: fixture.config,
      generatedGraphProvider,
    });

    fixture.config.pipelines = {
      demo: ['graph:prepare', 'graph:prepare'],
    };

    try {
      await expect(
        runPipeline(fixture.config, 'demo', {
          preflight,
        }),
      ).resolves.toBe(true);

      expect(generatedGraphProvider).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('shares generated graph preflight across graph, source, proof, and checker tasks', async () => {
    const fixture = await createPassingCheckPipelineConfig();
    const core = createAnalysisProviders(fixture.config);
    const generatedGraphProvider = vi.fn(() => core.buildGraph.getGraph());
    const plan = createExecutionPlan(fixture.config, 'demo');
    const recorder = createCheckRunRecorder({
      command: 'limina check demo',
      configPath: fixture.config.configPath,
      pipeline: 'demo',
      plannedTasks: plan.tasks,
      rootDir: fixture.config.rootDir,
    });

    try {
      await writeNotRunCheckIssueSnapshot({
        artifactNamespace: createLiminaArtifactNamespace({
          generation: 0,
          rootDir: fixture.config.rootDir,
        }),
        command: 'limina check demo',
        rootDir: fixture.config.rootDir,
        run: recorder.getRunSummary(),
      });

      await expect(
        runPipeline(fixture.config, 'demo', {
          checkRunRecorder: recorder,
          executionPlan: plan,
          providers: core,
          generatedGraphProvider,
        }),
      ).resolves.toBe(true);

      expect(generatedGraphProvider).toHaveBeenCalledTimes(1);
      const snapshot = await readCheckIssueSnapshot(fixture.config.rootDir);

      expect(snapshot).toMatchObject({
        run: {
          result: 'passed',
          tasks: [
            {
              issueTask: 'workspace:validate',
              kind: 'preparation',
              state: 'passed',
            },
            {
              issueTask: 'graph:materialize',
              kind: 'preparation',
              state: 'passed',
            },
            {
              checkItems: expect.arrayContaining([
                expect.objectContaining({
                  name: 'reference completeness',
                  status: 'passed',
                }),
              ]),
              label: 'graph:check',
            },
            {
              checkItems: expect.arrayContaining([
                expect.objectContaining({
                  name: 'source import authority',
                  status: 'passed',
                }),
              ]),
              label: 'source:check',
            },
            {
              checkItems: expect.arrayContaining([
                expect.objectContaining({
                  name: 'source coverage',
                  status: 'passed',
                }),
              ]),
              label: 'proof:check',
            },
            {
              checkItems: expect.arrayContaining([
                expect.objectContaining({
                  name: 'typescript checker entry',
                  status: 'passed',
                }),
              ]),
              label: 'checker:build',
            },
          ],
        },
      });

      const proofTask = snapshot?.run?.tasks.find(
        (task) => task.label === 'proof:check',
      );

      if (!proofTask?.checkItems) {
        throw new Error('Expected proof:check to record check items.');
      }

      const proofItemTotal = proofTask.checkItems.reduce(
        (total, item) => total + (item.checksTotal ?? 1),
        0,
      );

      expect(proofTask.checksPassed).toBe(proofItemTotal);
      expect(proofTask.checksTotal).toBe(proofItemTotal);
    } finally {
      await fixture.cleanup();
    }
  });

  it('writes an unexcluded overlap failure through the pre-validation namespace', async () => {
    const fixture = await createConfig();

    fixture.config.pipelines = { demo: ['source:check'] };
    await writeText(
      path.join(fixture.config.rootDir, 'pnpm-workspace.yaml'),
      'packages:\n  - app\n',
    );
    await writeText(
      path.join(fixture.config.rootDir, 'app/package.json'),
      stringifyJson({ name: '@example/app', private: true }),
    );
    await writeText(
      path.join(fixture.config.rootDir, 'app/pnpm-workspace.yaml'),
      'packages: []\n',
    );
    const plan = createExecutionPlan(fixture.config, 'demo');
    const recorder = createCheckRunRecorder({
      command: 'limina check demo',
      configPath: fixture.config.configPath,
      pipeline: 'demo',
      plannedTasks: plan.tasks,
      rootDir: fixture.config.rootDir,
    });

    try {
      await expect(
        runPipeline(fixture.config, 'demo', {
          checkRunRecorder: recorder,
          executionPlan: plan,
        }),
      ).resolves.toBe(false);

      const snapshot = await readCheckIssueSnapshot(fixture.config.rootDir);

      expect(snapshot).toMatchObject({
        issues: [
          {
            code: 'LIMINA_WORKSPACE_REGION_OVERLAP',
            filePath: 'app/pnpm-workspace.yaml',
            task: 'workspace:validate',
          },
        ],
        run: {
          result: 'blocked',
          tasks: [
            {
              issueTask: 'workspace:validate',
              state: 'failed',
            },
            {
              issueTask: 'source:check',
              state: 'blocked',
            },
          ],
        },
        status: 'completed',
        version: 7,
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('invalidates generated graph preflight after command steps', async () => {
    const fixture = await createConfig();
    let preflight: LiminaPreflightManager;
    const generatedGraphProvider = vi.fn(() =>
      preflight.providers.buildGraph.getGraph(),
    );
    preflight = new LiminaPreflightManager({
      config: fixture.config,
      generatedGraphProvider,
    });

    fixture.config.pipelines = {
      demo: [
        'graph:prepare',
        {
          args: ['-e', 'process.exit(0)'],
          command: process.execPath,
          type: 'command',
        },
        'graph:prepare',
      ],
    };

    try {
      await expect(
        runPipeline(fixture.config, 'demo', {
          preflight,
        }),
      ).resolves.toBe(true);

      expect(generatedGraphProvider).toHaveBeenCalledTimes(2);
    } finally {
      await fixture.cleanup();
    }
  });

  it('clears stale vue-tsgo cache before command steps', async () => {
    const fixture = await createConfig();

    await writeText(
      path.join(fixture.config.rootDir, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        type: 'module',
      }),
    );
    await writeText(
      path.join(fixture.config.rootDir, 'tsconfig.vue.build.json'),
      JSON.stringify({ files: [] }),
    );
    await writeText(
      path.join(fixture.config.rootDir, 'node_modules/.bin/vue-tsgo'),
      [
        '#!/usr/bin/env sh',
        'exec node "$(dirname "$0")/vue-tsgo.js" "$@"',
        '',
      ].join('\n'),
    );
    await writeText(
      path.join(fixture.config.rootDir, 'node_modules/.bin/vue-tsgo.js'),
      [
        "import { createHash } from 'node:crypto';",
        "import { existsSync, writeFileSync } from 'node:fs';",
        "import path from 'node:path';",
        'const configPath = path.resolve(process.cwd(), process.argv.at(-1));',
        "const hash = createHash('sha256').update(configPath).digest('hex').slice(0, 8);",
        "const stalePath = path.join(process.cwd(), 'node_modules/.cache/vue-tsgo', hash, 'stale.txt');",
        "writeFileSync(path.join(process.cwd(), 'stale-state.txt'), String(existsSync(stalePath)));",
        '',
      ].join('\n'),
    );
    await writeText(
      path.join(fixture.config.rootDir, 'node_modules/.bin/vue-tsgo.cmd'),
      ['@ECHO OFF', 'node "%~dp0vue-tsgo.js" %*', ''].join('\r\n'),
    );
    await chmod(
      path.join(fixture.config.rootDir, 'node_modules/.bin/vue-tsgo'),
      0o755,
    );
    await writeText(
      path.join(
        fixture.config.rootDir,
        'node_modules/.cache/vue-tsgo',
        createHash('sha256')
          .update(path.join(fixture.config.rootDir, 'tsconfig.vue.build.json'))
          .digest('hex')
          .slice(0, 8),
        'stale.txt',
      ),
      'stale\n',
    );

    fixture.config.pipelines = {
      vue: [
        {
          args: ['--build', 'tsconfig.vue.build.json'],
          command: 'vue-tsgo',
          type: 'command',
        },
      ],
    };

    try {
      await expect(runPipeline(fixture.config, 'vue')).resolves.toBe(true);
      await expect(
        readFile(path.join(fixture.config.rootDir, 'stale-state.txt'), 'utf8'),
      ).resolves.toBe('false');
    } finally {
      await fixture.cleanup();
    }
  });

  it('passes package selection to package-aware built-in tasks', async () => {
    const fixture = await createConfig();

    try {
      const validOutDir = await createOutputPackage(
        fixture.config.rootDir,
        '@example/valid',
        "import '@example/dep';\n",
      );
      const invalidOutDir = await createOutputPackage(
        fixture.config.rootDir,
        '@example/invalid',
        "import 'node:fs';\n",
      );

      fixture.config.package = {
        entries: [
          {
            checks: ['boundary'],
            name: '@example/valid',
            outDir: validOutDir,
          },
          {
            checks: ['boundary'],
            name: '@example/invalid',
            outDir: invalidOutDir,
          },
        ],
      };
      fixture.config.pipelines = {
        publish: ['package:check'],
      };

      await expect(
        runPipeline(fixture.config, 'publish', {
          packageNames: ['@example/valid'],
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('collapses successful interactive command output', async () => {
    const fixture = await createConfig();
    const { chunks, flow } = createTtyFlow();

    fixture.config.pipelines = {
      demo: [
        {
          args: [
            '-e',
            "console.log(Buffer.from('Y29tbWFuZCBkZXRhaWw=', 'base64').toString())",
          ],
          command: process.execPath,
          type: 'command',
        },
      ],
    };

    try {
      await expect(runPipeline(fixture.config, 'demo', { flow })).resolves.toBe(
        true,
      );

      expect(chunks.some((chunk) => chunk.includes('◇      command: '))).toBe(
        true,
      );
      expect(chunks.some((chunk) => chunk.includes('command detail'))).toBe(
        true,
      );
      expect(
        chunks.some((chunk) => chunk.includes('\u001B[H\u001B[2J\u001B[3J')),
      ).toBe(false);
      expect(chunks.some((chunk) => chunk.includes('\u001B[J'))).toBe(true);
      expect(
        chunks.some((chunk) => chunk.includes(`${green('◆')}      command: `)),
      ).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('omits interactive command output in check-flow mode', async () => {
    const fixture = await createConfig();
    const { chunks, flow } = createCheckTtyFlow();

    fixture.config.pipelines = {
      demo: [
        {
          args: [
            '-e',
            "console.log(Buffer.from('Y29tbWFuZCBkZXRhaWw=', 'base64').toString())",
          ],
          command: process.execPath,
          type: 'command',
        },
      ],
    };

    try {
      await expect(runPipeline(fixture.config, 'demo', { flow })).resolves.toBe(
        true,
      );

      expect(chunks.some((chunk) => chunk.includes('command detail'))).toBe(
        false,
      );
      expect(
        chunks.some(
          (chunk) =>
            chunk.includes(green('◆')) && chunk.includes('command execution'),
        ),
      ).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('marks the blocking step and skips remaining steps on failure', async () => {
    const fixture = await createConfig();
    const { chunks, flow } = createFlow();

    fixture.config.pipelines = {
      demo: [
        {
          args: ['-e', 'process.exit(1)'],
          command: process.execPath,
          type: 'command',
        },
        {
          args: ['-e', 'process.exit(0)'],
          command: process.execPath,
          type: 'command',
        },
      ],
    };

    try {
      await expect(runPipeline(fixture.config, 'demo', { flow })).resolves.toBe(
        false,
      );

      expect(chunks.some((chunk) => chunk.includes('[fail] command:'))).toBe(
        true,
      );
      expect(
        chunks.some((chunk) => chunk.includes('[fail] pipeline blocked: demo')),
      ).toBe(true);
      expect(chunks.some((chunk) => chunk.includes('[skip] command:'))).toBe(
        true,
      );
      expect(chunks.some((chunk) => chunk.includes('skipped after'))).toBe(
        true,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('records blocked result and skipped tasks after a failed command step', async () => {
    const fixture = await createConfig();

    fixture.config.pipelines = {
      demo: [
        {
          args: ['-e', 'process.exit(1)'],
          command: process.execPath,
          type: 'command',
        },
        {
          args: ['-e', 'process.exit(0)'],
          command: process.execPath,
          type: 'command',
        },
      ],
    };

    const plan = createExecutionPlan(fixture.config, 'demo');
    const plannedTasks = describePipeline(plan);
    const recorder = createCheckRunRecorder({
      command: 'limina check demo',
      configPath: fixture.config.configPath,
      pipeline: 'demo',
      plannedTasks: plan.tasks,
      rootDir: fixture.config.rootDir,
    });

    try {
      await writeNotRunCheckIssueSnapshot({
        artifactNamespace: createLiminaArtifactNamespace({
          generation: 0,
          rootDir: fixture.config.rootDir,
        }),
        command: 'limina check demo',
        rootDir: fixture.config.rootDir,
        run: recorder.getRunSummary(),
      });

      await expect(
        runPipeline(fixture.config, 'demo', {
          checkRunRecorder: recorder,
          executionPlan: plan,
        }),
      ).resolves.toBe(false);

      const snapshot = await readCheckIssueSnapshot(fixture.config.rootDir);

      expect(snapshot?.issues).toHaveLength(1);
      expect(snapshot?.issues[0]).toMatchObject({
        code: 'LIMINA_COMMAND_FAILED',
        task: 'command',
      });
      expect(snapshot?.run).toMatchObject({
        blockedBy: {
          label: plannedTasks[0]?.label,
        },
        result: 'blocked',
        tasks: [
          {
            label: plannedTasks[0]?.label,
            state: 'failed',
          },
          {
            label: plannedTasks[1]?.label,
            state: 'skipped',
          },
        ],
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    {
      expected: true,
      result: 'passed',
      steps: [
        {
          args: ['-e', 'process.exit(0)'],
          command: process.execPath,
          type: 'command' as const,
        },
      ],
    },
    {
      expected: false,
      result: 'blocked',
      steps: [
        {
          args: ['-e', 'process.exit(1)'],
          command: process.execPath,
          type: 'command' as const,
        },
        {
          args: ['-e', 'process.exit(0)'],
          command: process.execPath,
          type: 'command' as const,
        },
      ],
    },
  ])(
    'keeps committed $result authoritative when parent projection and warning fail',
    async ({ expected, result, steps }) => {
      const fixture = await createConfig();
      fixture.config.pipelines = { demo: steps };
      const plan = createExecutionPlan(fixture.config, 'demo');
      const recorder = createCheckRunRecorder({
        command: 'limina check demo',
        plannedTasks: plan.tasks,
        rootDir: fixture.config.rootDir,
      });
      const finish = vi.spyOn(recorder, 'finish');
      const taskNode = {
        block() {},
        child() {
          return taskNode;
        },
        children() {
          return [];
        },
        fail() {},
        pass() {},
        skip() {},
        start() {},
      };
      const parentNode = {
        fail() {
          throw new Error('parent projection failed');
        },
        pass() {
          throw new Error('parent projection failed');
        },
      };
      const flow = {
        start: () => parentNode,
        tree: () => taskNode,
      } as unknown as LiminaFlowReporter;
      const warning = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => {
          throw new Error('warning reporter failed');
        });
      const previousExitCode = process.exitCode;
      process.exitCode = 23;

      try {
        await writeNotRunCheckIssueSnapshot({
          artifactNamespace: createLiminaArtifactNamespace({
            generation: 0,
            rootDir: fixture.config.rootDir,
          }),
          command: 'limina check demo',
          rootDir: fixture.config.rootDir,
          run: recorder.getRunSummary(),
        });
        await expect(
          runPipeline(fixture.config, 'demo', {
            checkRunRecorder: recorder,
            executionPlan: plan,
            flow,
          }),
        ).resolves.toBe(expected);

        expect(
          await readCheckIssueSnapshot(fixture.config.rootDir),
        ).toMatchObject({
          run: { result },
          status: 'completed',
        });
        expect(finish).toHaveBeenCalledTimes(1);
        expect(process.exitCode).toBe(23);
      } finally {
        process.exitCode = previousExitCode;
        warning.mockRestore();
        await fixture.cleanup();
      }
    },
  );
});
