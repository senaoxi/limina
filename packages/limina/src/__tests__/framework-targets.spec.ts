import type { ResolvedLiminaConfig } from '#config/runner';
import type {
  FrameworkCapabilityDescriptor,
  GeneratedTsconfigGraphResult,
  GovernedSourceUnit,
} from '#core/build-graph/runner';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runCheckerTypecheck } from '../commands/typecheck';
import { createLiminaArtifactNamespace } from '../domain/artifacts/namespace';
import { createArtifactPlan } from '../domain/artifacts/plan';
import type {
  TaskProgressItem,
  TaskProgressReporter,
} from '../execution/progress';
import { LiminaPreflightManager } from '../preflight';
import {
  collectFrameworkCapabilityDescriptors,
  collectFrameworkTargetPreflightFailures,
  createDefaultRunner,
  createFrameworkCheckerTarget,
  createFrameworkCheckerTargets,
  type TypecheckTarget,
} from '../typecheck/targets';
import { createFixturePathResolver, toPortablePath } from './helpers/path';

const requireFromTest = createRequire(import.meta.url);

async function writeText(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value);
}

async function createFixture(): Promise<{
  cleanup: () => Promise<void>;
  config: ResolvedLiminaConfig;
  path: (...segments: string[]) => string;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-framework-target-')),
  );
  const fixturePath = createFixturePathResolver(rootDir);
  await writeText(
    fixturePath('package.json'),
    '{"name":"fixture","private":true}\n',
  );
  await writeText(
    fixturePath('pnpm-workspace.yaml'),
    'packages:\n  - packages/*\n',
  );
  await writeText(fixturePath('limina.config.mjs'), 'export default {};\n');
  for (const leaf of ['a', 'b']) {
    await writeText(
      fixturePath('packages', leaf, 'package.json'),
      `{"name":"@fixture/${leaf}","private":true}\n`,
    );
    await writeText(
      fixturePath('packages', leaf, 'tsconfig.json'),
      '{"include":["src/**/*"]}\n',
    );
  }
  await writeText(
    fixturePath('packages', 'a', '.astro', 'types.d.ts'),
    '/// <reference types="astro/client" />\n',
  );
  return {
    cleanup: async () => rm(rootDir, { force: true, recursive: true }),
    config: {
      configPath: fixturePath('limina.config.mjs'),
      rootDir,
    },
    path: fixturePath,
    rootDir,
  };
}

function createGovernedSource(options: {
  capabilities: FrameworkCapabilityDescriptor[];
  configPath: string;
  packageRootDir: string;
}): GovernedSourceUnit {
  return {
    buildProjection: {
      buildConfigPath: options.configPath,
      kind: 'transparent-solution',
    },
    configPath: options.configPath,
    context: { checkerPresets: ['tsc'], extensions: [] },
    declarationFileNames: [],
    declarationReferences: new Set(),
    frameworkCapabilities: options.capabilities,
    ownedFileNames: [],
    packageRootDir: options.packageRootDir,
    primaryCheckerName: 'tsc',
    semanticAuthority: {
      family: 'typescript',
      kind: 'locked',
      source: 'explicit',
    },
  };
}

function createGraph(options: {
  checkers?: GeneratedTsconfigGraphResult['checkers'];
  descriptorsByChecker: Record<string, FrameworkCapabilityDescriptor[]>;
  namespace?: ReturnType<typeof createLiminaArtifactNamespace>;
  rootDir: string;
}): GeneratedTsconfigGraphResult {
  const namespace =
    options.namespace ??
    createLiminaArtifactNamespace({
      generation: 0,
      rootDir: options.rootDir,
    });
  const governedSources = new Map<string, Map<string, GovernedSourceUnit>>();
  for (const [checkerName, descriptors] of Object.entries(
    options.descriptorsByChecker,
  )) {
    const units = new Map<string, GovernedSourceUnit>();
    for (const descriptor of descriptors) {
      const current = units.get(descriptor.sourceConfigPath);
      units.set(
        descriptor.sourceConfigPath,
        createGovernedSource({
          capabilities: [...(current?.frameworkCapabilities ?? []), descriptor],
          configPath: descriptor.sourceConfigPath,
          packageRootDir: descriptor.packageRootDir,
        }),
      );
    }
    governedSources.set(checkerName, units);
  }
  return {
    artifactPlan: createArtifactPlan(namespace, [], []),
    changed: false,
    checkerEntries: new Map(),
    checkers: options.checkers ?? [],
    governedSources,
  } as unknown as GeneratedTsconfigGraphResult;
}

function descriptor(options: {
  family: FrameworkCapabilityDescriptor['family'];
  packageRootDir: string;
  sourceConfigPath: string;
}): FrameworkCapabilityDescriptor {
  return options;
}

function createProgressRecorder(): {
  events: string[];
  reporter: TaskProgressReporter;
} {
  const events: string[] = [];
  const createItem = (name: string): TaskProgressItem => ({
    fail: () => events.push(`fail:${name}`),
    pass: () => events.push(`pass:${name}`),
    skip: () => events.push(`skip:${name}`),
    start: () => events.push(`start:${name}`),
  });
  return {
    events,
    reporter: {
      planItem: (name) => {
        events.push(`plan:${name}`);
        return createItem(name);
      },
      planItems: (names) => names.map(createItem),
      startItem: (name) => {
        const item = createItem(name);
        item.start();
        return item;
      },
    },
  };
}

describe('framework checker targets', () => {
  it('verifies the minimum supported framework checker CLI contracts', async () => {
    const astroManifestPath = requireFromTest.resolve(
      'astro-v7-min/package.json',
    );
    const astroManifest = JSON.parse(
      await readFile(astroManifestPath, 'utf8'),
    ) as { version: string };
    const astroCheckSource = await readFile(
      path.join(path.dirname(astroManifestPath), 'dist/cli/check/index.js'),
      'utf8',
    );
    const svelteCheckManifestPath = requireFromTest.resolve(
      'svelte-check-v4-min/package.json',
    );
    const svelteCheckManifest = JSON.parse(
      await readFile(svelteCheckManifestPath, 'utf8'),
    ) as { bin: string; version: string };
    const svelteManifest = JSON.parse(
      await readFile(
        requireFromTest.resolve('svelte-v4-min/package.json'),
        'utf8',
      ),
    ) as { version: string };
    const svelteHelp = spawnSync(
      process.execPath,
      [
        path.join(
          path.dirname(svelteCheckManifestPath),
          svelteCheckManifest.bin,
        ),
        '--help',
      ],
      { encoding: 'utf8' },
    );

    expect(astroManifest.version).toBe('7.0.0');
    expect(astroCheckSource).toContain('if (!flags.noSync && !flags.help)');
    expect(astroCheckSource).toContain('"@astrojs/check"');
    expect(astroCheckSource).toContain('["typescript"]');
    expect(svelteCheckManifest.version).toBe('4.0.0');
    expect(svelteManifest.version).toBe('4.0.0');
    expect(svelteHelp.status).toBe(0);
    expect(svelteHelp.stdout).toContain('--workspace');
    expect(svelteHelp.stdout).toContain('--tsconfig');
    expect(svelteHelp.stdout).toContain('--diagnostic-sources');
  });

  it('deduplicates descriptors and creates separate Astro and Svelte targets for one config', async () => {
    const fixture = await createFixture();
    try {
      const packageRootDir = fixture.path('packages', 'a');
      const sourceConfigPath = fixture.path('packages', 'a', 'tsconfig.json');
      const astro = descriptor({
        family: 'astro',
        packageRootDir,
        sourceConfigPath,
      });
      const svelte = descriptor({
        family: 'svelte',
        packageRootDir,
        sourceConfigPath,
      });
      const graph = createGraph({
        descriptorsByChecker: {
          first: [astro, svelte],
          second: [astro, svelte],
        },
        rootDir: fixture.rootDir,
      });

      expect(collectFrameworkCapabilityDescriptors(graph)).toEqual([
        astro,
        svelte,
      ]);
      const targets = createFrameworkCheckerTargets({
        generatedGraph: graph,
        workspaceRootDir: toPortablePath(fixture.rootDir),
      });

      expect(targets).toHaveLength(2);
      expect(new Set(targets.map((target) => target.id))).toHaveProperty(
        'size',
        2,
      );
      expect(targets.map((target) => target.checkerName)).toEqual([
        'astro',
        'svelte-check',
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('derives framework targets from ownership without re-filtering them by config policy', async () => {
    const fixture = await createFixture();
    try {
      const aConfig = fixture.path('packages', 'a', 'tsconfig.json');
      const bConfig = fixture.path('packages', 'b', 'tsconfig.json');
      const graph = createGraph({
        descriptorsByChecker: {
          tsc: [
            descriptor({
              family: 'svelte',
              packageRootDir: fixture.path('packages', 'a'),
              sourceConfigPath: aConfig,
            }),
            descriptor({
              family: 'astro',
              packageRootDir: fixture.path('packages', 'b'),
              sourceConfigPath: bConfig,
            }),
          ],
        },
        rootDir: fixture.rootDir,
      });
      const config: ResolvedLiminaConfig = {
        ...fixture.config,
        config: {
          checkers: {
            astro: { include: ['packages/a/tsconfig.json'] },
            'svelte-check': {
              exclude: ['packages/b/tsconfig.json'],
              include: ['packages/**/tsconfig.json'],
            },
            tsc: { include: ['packages/**/tsconfig.json'] },
          },
        },
      };

      expect(
        createFrameworkCheckerTargets({
          config,
          generatedGraph: graph,
          workspaceRootDir: fixture.rootDir,
        }).map((target) => target.checkerName),
      ).toEqual(['svelte-check', 'astro']);

      const emptyGraph = createGraph({
        descriptorsByChecker: { tsc: [] },
        rootDir: fixture.rootDir,
      });
      expect(
        createFrameworkCheckerTargets({
          config,
          generatedGraph: emptyGraph,
          workspaceRootDir: fixture.rootDir,
        }),
      ).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps framework typecheck targets outside the build checker registry', async () => {
    const fixture = await createFixture();
    try {
      const packageRootDir = fixture.path('packages', 'a');
      const sourceConfigPath = fixture.path('packages', 'a', 'tsconfig.json');
      const astro = descriptor({
        family: 'astro',
        packageRootDir,
        sourceConfigPath,
      });
      const svelte = descriptor({
        family: 'svelte',
        packageRootDir,
        sourceConfigPath,
      });
      const graph = createGraph({
        checkers: [],
        descriptorsByChecker: {
          svelte: [svelte],
          typescript: [astro, svelte],
        },
        rootDir: fixture.rootDir,
      });

      expect(collectFrameworkCapabilityDescriptors(graph)).toEqual([
        astro,
        svelte,
      ]);
      expect(
        createFrameworkCheckerTargets({
          generatedGraph: graph,
          workspaceRootDir: fixture.rootDir,
        }).map((target) => target.checkerFamily),
      ).toEqual(['astro', 'svelte']);
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps same-named leaf configs collision-free and rejects dependency-root drift', async () => {
    const fixture = await createFixture();
    try {
      const targets = ['a', 'b'].map((leaf) =>
        createFrameworkCheckerTarget({
          descriptor: descriptor({
            family: 'svelte',
            packageRootDir: fixture.path('packages', leaf),
            sourceConfigPath: fixture.path('packages', leaf, 'tsconfig.json'),
          }),
          workspaceRootDir: fixture.rootDir,
        }),
      );
      expect(targets[0]!.id).not.toBe(targets[1]!.id);

      const sourceConfigPath = fixture.path('packages', 'a', 'tsconfig.json');
      const graph = createGraph({
        descriptorsByChecker: {
          first: [
            descriptor({
              family: 'svelte',
              packageRootDir: fixture.path('packages', 'a'),
              sourceConfigPath,
            }),
          ],
          second: [
            descriptor({
              family: 'svelte',
              packageRootDir: fixture.path('packages', 'b'),
              sourceConfigPath,
            }),
          ],
        },
        rootDir: fixture.rootDir,
      });
      expect(() => collectFrameworkCapabilityDescriptors(graph)).toThrow(
        'dependency root drifted',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses leaf execution roots and complete non-mutating checker arguments', async () => {
    const fixture = await createFixture();
    try {
      const packageRootDir = fixture.path('packages', 'a');
      const sourceConfigPath = fixture.path('packages', 'a', 'tsconfig.json');
      const astro = createFrameworkCheckerTarget({
        descriptor: descriptor({
          family: 'astro',
          packageRootDir,
          sourceConfigPath,
        }),
        workspaceRootDir: toPortablePath(fixture.rootDir),
      });
      const svelte = createFrameworkCheckerTarget({
        descriptor: descriptor({
          family: 'svelte',
          packageRootDir,
          sourceConfigPath,
        }),
        workspaceRootDir: fixture.rootDir,
      });

      expect(astro).toMatchObject({
        args: [
          'check',
          '--noSync',
          '--root',
          packageRootDir,
          '--tsconfig',
          sourceConfigPath,
        ],
        command: 'astro',
        cwd: packageRootDir,
        dependencyRootDir: packageRootDir,
        executionRootDir: packageRootDir,
        workspaceRootDir: toPortablePath(fixture.rootDir),
      });
      expect(svelte.args).toEqual([
        '--workspace',
        packageRootDir,
        '--tsconfig',
        sourceConfigPath,
      ]);
      expect(svelte.args).not.toContain('--diagnostic-sources');
      expect(svelte.args).not.toContain('--incremental');
    } finally {
      await fixture.cleanup();
    }
  });

  it('resolves checker and runtime peers only from each leaf dependency root', async () => {
    const fixture = await createFixture();
    try {
      const target = createFrameworkCheckerTarget({
        descriptor: descriptor({
          family: 'svelte',
          packageRootDir: fixture.path('packages', 'a'),
          sourceConfigPath: fixture.path('packages', 'a', 'tsconfig.json'),
        }),
        workspaceRootDir: fixture.rootDir,
      });
      const resolver = vi.fn(({ packageName, projectRootDir }) =>
        projectRootDir === fixture.path('packages', 'a') &&
        packageName === 'svelte-check'
          ? packageName
          : undefined,
      );

      const failures = collectFrameworkTargetPreflightFailures({
        resolvePackage: resolver,
        targets: [target],
        workspaceRootDir: fixture.rootDir,
      });

      expect(
        new Set(resolver.mock.calls.map(([call]) => call.projectRootDir)),
      ).toEqual(new Set([fixture.path('packages', 'a')]));
      expect(failures).toHaveLength(1);
      expect(failures[0]!.problems.join('\n')).toContain(
        'missing package: svelte',
      );
      expect(failures[0]!.problems.join('\n')).toContain(
        'missing package: svelte2tsx',
      );
      expect(failures[0]!.problems.join('\n')).toContain(
        'dependency category: checker runtime dependency',
      );
      expect(failures[0]!.problems.join('\n')).toContain(
        'pnpm --dir packages/a add -D svelte svelte2tsx typescript',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports an unsupported svelte-check from the leaf checker scope', async () => {
    const fixture = await createFixture();
    try {
      const packageRootDir = fixture.path('packages', 'a');
      const svelteCheckManifest = fixture.path(
        'packages',
        'a',
        'node_modules',
        'svelte-check',
        'package.json',
      );
      await writeText(
        svelteCheckManifest,
        JSON.stringify({ name: 'svelte-check', version: '5.0.0' }),
      );
      const target = createFrameworkCheckerTarget({
        descriptor: descriptor({
          family: 'svelte',
          packageRootDir,
          sourceConfigPath: fixture.path('packages', 'a', 'tsconfig.json'),
        }),
        workspaceRootDir: fixture.rootDir,
      });
      const failures = collectFrameworkTargetPreflightFailures({
        resolvePackage: ({ packageName }) =>
          packageName === 'svelte-check' ? svelteCheckManifest : packageName,
        targets: [target],
        workspaceRootDir: fixture.rootDir,
      });
      const problems = failures
        .flatMap((failure) => failure.problems)
        .join('\n');

      expect(problems).toContain('Unsupported external checker:');
      expect(problems).toContain('installed version: 5.0.0');
      expect(problems).toContain('supported range: >=4.0.0 <5.0.0');
      expect(problems).toContain('checker execution scope: packages/a');
    } finally {
      await fixture.cleanup();
    }
  });

  it('classifies missing Astro checker binaries at the leaf root', async () => {
    const fixture = await createFixture();
    try {
      const target = createFrameworkCheckerTarget({
        descriptor: descriptor({
          family: 'astro',
          packageRootDir: fixture.path('packages', 'a'),
          sourceConfigPath: fixture.path('packages', 'a', 'tsconfig.json'),
        }),
        workspaceRootDir: fixture.rootDir,
      });
      const failures = collectFrameworkTargetPreflightFailures({
        resolvePackage: ({ packageName }) =>
          packageName === 'typescript' ? packageName : undefined,
        targets: [target],
        workspaceRootDir: fixture.rootDir,
      });
      const problems = failures[0]!.problems.join('\n');

      expect(problems).toContain('missing package: astro');
      expect(problems).toContain('missing package: @astrojs/check');
      expect(problems).toContain('dependency category: checker binary');
      expect(problems).toContain(
        'pnpm --dir packages/a add -D astro @astrojs/check',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not accept framework dependencies inherited from an ancestor root', async () => {
    const fixture = await createFixture();
    try {
      const packagePath = requireFromTest.resolve('svelte-v4-min/package.json');
      await mkdir(fixture.path('node_modules'), { recursive: true });
      await symlink(
        path.dirname(packagePath),
        fixture.path('node_modules', 'svelte'),
        'junction',
      );
      const target = createFrameworkCheckerTarget({
        descriptor: descriptor({
          family: 'svelte',
          packageRootDir: fixture.path('packages', 'a'),
          sourceConfigPath: fixture.path('packages', 'a', 'tsconfig.json'),
        }),
        workspaceRootDir: fixture.rootDir,
      });

      const problems = collectFrameworkTargetPreflightFailures({
        targets: [target],
        workspaceRootDir: fixture.rootDir,
      }).flatMap((failure) => failure.problems);

      expect(problems.join('\n')).toContain('missing package: svelte');
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports missing Astro generated types without running sync', async () => {
    const fixture = await createFixture();
    try {
      const target = createFrameworkCheckerTarget({
        descriptor: descriptor({
          family: 'astro',
          packageRootDir: fixture.path('packages', 'b'),
          sourceConfigPath: fixture.path('packages', 'b', 'tsconfig.json'),
        }),
        workspaceRootDir: fixture.rootDir,
      });
      const failures = collectFrameworkTargetPreflightFailures({
        resolvePackage: ({ packageName }) => packageName,
        targets: [target],
        workspaceRootDir: fixture.rootDir,
      });

      expect(failures[0]!.problems.join('\n')).toContain(
        'packages/b/.astro/types.d.ts',
      );
      expect(failures[0]!.problems.join('\n')).toContain(
        'Limina never runs Astro sync automatically.',
      );
      expect(failures[0]!.problems.join('\n')).toContain(
        'pnpm --dir packages/b exec astro sync',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses the leaf binary PATH and cwd in the default runner', async () => {
    const fixture = await createFixture();
    try {
      const packageRootDir = fixture.path('packages', 'a');
      const recordPath = fixture.path('packages', 'a', 'runner-record.json');
      const binDir = fixture.path('packages', 'a', 'node_modules', '.bin');
      await writeText(
        path.join(binDir, 'svelte-check'),
        '#!/usr/bin/env sh\nexec node "$(dirname "$0")/svelte-check.js" "$@"\n',
      );
      await writeText(
        path.join(binDir, 'svelte-check.cmd'),
        '@ECHO OFF\r\nnode "%~dp0svelte-check.js" %*\r\n',
      );
      await writeText(
        path.join(binDir, 'svelte-check.js'),
        [
          "const { writeFileSync } = require('node:fs');",
          `writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), path: process.env.PATH }));`,
          '',
        ].join('\n'),
      );
      await chmod(path.join(binDir, 'svelte-check'), 0o755);
      const target = createFrameworkCheckerTarget({
        descriptor: descriptor({
          family: 'svelte',
          packageRootDir,
          sourceConfigPath: fixture.path('packages', 'a', 'tsconfig.json'),
        }),
        workspaceRootDir: fixture.rootDir,
      });

      const result = await createDefaultRunner({ stdio: 'ignore' })(target);
      const record = JSON.parse(await readFile(recordPath, 'utf8')) as {
        args: string[];
        cwd: string;
        path: string;
      };

      expect(result.status).toBe(0);
      expect(toPortablePath(record.cwd)).toBe(toPortablePath(packageRootDir));
      expect(toPortablePath(record.path.split(path.delimiter)[0]!)).toBe(
        toPortablePath(binDir),
      );
      expect(record.args).toEqual(target.args);
    } finally {
      await fixture.cleanup();
    }
  });

  it('propagates cancellation while preserving progress and result identity maps', async () => {
    const fixture = await createFixture();
    try {
      const packageRootDir = fixture.path('packages', 'a');
      const sourceConfigPath = fixture.path('packages', 'a', 'tsconfig.json');
      const descriptors = (['astro', 'svelte'] as const).map((family) =>
        descriptor({ family, packageRootDir, sourceConfigPath }),
      );
      let graph!: GeneratedTsconfigGraphResult;
      const preflight = new LiminaPreflightManager({
        config: fixture.config,
        generatedGraphProvider: async () => graph,
      });
      graph = createGraph({
        descriptorsByChecker: { typescript: descriptors },
        namespace: preflight.artifactNamespace,
        rootDir: fixture.rootDir,
      });
      const controller = new AbortController();
      controller.abort(new Error('cancel framework targets'));
      const progress = createProgressRecorder();
      const calls: TypecheckTarget[] = [];

      const result = await runCheckerTypecheck({
        checkerPackageResolver: ({ packageName, projectRootDir }) => {
          expect(projectRootDir).toBe(packageRootDir);
          return packageName;
        },
        config: fixture.config,
        cwd: fixture.rootDir,
        generatedGraphProvider: async () => graph,
        preflight,
        progress: progress.reporter,
        runner: async (target, runOptions) => {
          calls.push(target);
          expect(runOptions?.signal).toBe(controller.signal);
          runOptions?.signal?.throwIfAborted();
          return { configPath: target.configPath, status: 0 };
        },
        signal: controller.signal,
      });

      expect(result.passed).toBe(false);
      expect(calls).toHaveLength(2);
      expect(result.targetResults).toHaveLength(2);
      expect(new Set(result.targetResults.map((item) => item.id))).toEqual(
        new Set(calls.map((target) => target.id)),
      );
      expect(
        progress.events.filter((event) => event.startsWith('plan:')),
      ).toHaveLength(2);
      expect(
        progress.events.filter((event) => event.startsWith('start:')),
      ).toHaveLength(2);
      expect(
        progress.events.filter((event) => event.startsWith('fail:')),
      ).toHaveLength(2);
    } finally {
      await fixture.cleanup();
    }
  });
});
