import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCheckerTargetId,
  createDefaultRunner,
  createVueTsgoCachePaths,
  type TypecheckTarget,
} from '../typecheck/targets';
import { VueTsgoCacheBatchCoordinator } from '../typecheck/vue-tsgo-cache';
import {
  createExplicitMutationAuthority,
  type MutationBoundaryTarget,
  preflightMutationBoundary,
  recheckMutationBoundary,
} from '../utils/mutation-boundary';

async function writeText(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

async function createFixture(): Promise<{
  cleanup: () => Promise<void>;
  path: (...segments: string[]) => string;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-vue-tsgo-cache-')),
  );
  return {
    cleanup: () => rm(rootDir, { force: true, recursive: true }),
    path: (...segments) => path.join(rootDir, ...segments),
    rootDir,
  };
}

function createTarget(options: {
  configPath: string;
  rootDir: string;
}): TypecheckTarget {
  return {
    args: ['--project', options.configPath],
    command: 'vue-tsgo',
    configPath: options.configPath,
    cwd: options.rootDir,
    id: createCheckerTargetId(['vue-tsgo-cache-test', options.configPath]),
  };
}

afterEach(() => {
  delete process.env.LIMINA_CHECKER_HOST;
});

describe('vue-tsgo cache batch coordinator', () => {
  it('attributes cleanup descriptors to one generation without consuming another generation resource', async () => {
    const fixture = await createFixture();
    const currentConfig = fixture.path('packages/current/tsconfig.json');
    const foreignConfig = fixture.path('packages/foreign/tsconfig.json');
    for (const packageName of ['current', 'foreign']) {
      await writeText(
        fixture.path(`packages/${packageName}/package.json`),
        `${JSON.stringify({ name: `@fixture/${packageName}` })}\n`,
      );
      await writeText(
        fixture.path(`packages/${packageName}/tsconfig.json`),
        '{"files":[]}\n',
      );
    }
    const currentCache = createVueTsgoCachePaths(currentConfig)[0]!;
    const foreignCache = createVueTsgoCachePaths(foreignConfig)[0]!;
    const currentMarker = path.join(currentCache, 'stale.txt');
    const foreignMarker = path.join(foreignCache, 'stale.txt');
    await writeText(currentMarker, 'current generation stale bytes\n');
    await writeText(foreignMarker, 'foreign generation stale bytes\n');
    const foreignAuthority = await createExplicitMutationAuthority({
      generation: 'foreign-generation',
      logicalMutationRoot: foreignCache,
      scope: 'directory',
      trustedBasePath: fixture.path('packages/foreign'),
    });
    const foreignDescriptor: MutationBoundaryTarget = {
      authority: foreignAuthority,
      kind: 'directory',
      path: foreignCache,
      recursive: true,
    };
    const foreignSnapshot = await preflightMutationBoundary([
      foreignDescriptor,
    ]);
    const observed: MutationBoundaryTarget[] = [];

    try {
      await VueTsgoCacheBatchCoordinator.prepare(
        [
          createTarget({
            configPath: currentConfig,
            rootDir: fixture.rootDir,
          }),
        ],
        {
          cleanup: {
            observeDescriptor: (descriptor) => {
              observed.push(descriptor);
            },
          },
          requireValidGeneratedRoute: false,
        },
      );

      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({
        kind: 'directory',
        path: currentCache,
        recursive: true,
      });
      expect(observed[0]!.authority).toMatchObject({
        logicalMutationRoot: currentCache,
        scope: 'directory',
      });
      expect(observed[0]!.authority.generation).not.toBe(
        foreignAuthority.generation,
      );
      await expect(readFile(currentMarker, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(recheckMutationBoundary(foreignSnapshot)).resolves.toBe(
        undefined,
      );
      await expect(readFile(foreignMarker, 'utf8')).resolves.toBe(
        'foreign generation stale bytes\n',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps every safe cache unchanged when any cache subtree is unsafe', async () => {
    const fixture = await createFixture();
    const safeConfig = fixture.path('packages/safe/tsconfig.json');
    const unsafeConfig = fixture.path('packages/unsafe/tsconfig.json');
    const markerPath = fixture.path('external/marker.txt');
    for (const packageName of ['safe', 'unsafe']) {
      await writeText(
        fixture.path(`packages/${packageName}/package.json`),
        `${JSON.stringify({ name: `@fixture/${packageName}` })}\n`,
      );
      await writeText(
        fixture.path(`packages/${packageName}/tsconfig.json`),
        '{"files":[]}\n',
      );
    }
    await writeText(markerPath, 'external marker bytes\n');
    const safeCache = createVueTsgoCachePaths(safeConfig)[0]!;
    const unsafeCache = createVueTsgoCachePaths(unsafeConfig)[0]!;
    const safeStalePath = path.join(safeCache, 'stale.txt');
    await writeText(safeStalePath, 'safe stale bytes\n');
    await mkdir(unsafeCache, { recursive: true });
    await symlink(
      fixture.path('external'),
      path.join(unsafeCache, 'nested-link'),
    );

    try {
      await expect(
        VueTsgoCacheBatchCoordinator.prepare(
          [
            createTarget({ configPath: safeConfig, rootDir: fixture.rootDir }),
            createTarget({
              configPath: unsafeConfig,
              rootDir: fixture.rootDir,
            }),
          ],
          { requireValidGeneratedRoute: false },
        ),
      ).rejects.toThrow('symbolic link or junction');
      await expect(readFile(safeStalePath, 'utf8')).resolves.toBe(
        'safe stale bytes\n',
      );
      await expect(readFile(markerPath, 'utf8')).resolves.toBe(
        'external marker bytes\n',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('detects cache drift after the one batch cleanup and before runner', async () => {
    const fixture = await createFixture();
    const configPath = fixture.path('packages/app/tsconfig.json');
    const markerPath = fixture.path('external/marker.txt');
    await writeText(
      fixture.path('packages/app/package.json'),
      '{"name":"@fixture/app"}\n',
    );
    await writeText(configPath, '{"files":[]}\n');
    await writeText(markerPath, 'external marker bytes\n');
    const target = createTarget({ configPath, rootDir: fixture.rootDir });
    const cachePath = createVueTsgoCachePaths(configPath)[0]!;
    await writeText(path.join(cachePath, 'stale.txt'), 'stale bytes\n');

    try {
      const coordinator = await VueTsgoCacheBatchCoordinator.prepare([target], {
        requireValidGeneratedRoute: false,
      });
      await symlink(fixture.path('external'), cachePath);

      await expect(coordinator.beforeTargetRun(target)).rejects.toThrow(
        'symbolic link or junction',
      );
      await expect(readFile(markerPath, 'utf8')).resolves.toBe(
        'external marker bytes\n',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not perform cache cleanup inside the default runner', async () => {
    const fixture = await createFixture();
    const configPath = fixture.path('packages/app/tsconfig.json');
    const commandPath = fixture.path('bin/vue-tsgo.cjs');
    await writeText(
      fixture.path('packages/app/package.json'),
      '{"name":"@fixture/app"}\n',
    );
    await writeText(configPath, '{"files":[]}\n');
    await writeText(commandPath, 'process.exit(0);\n');
    const stalePath = path.join(
      createVueTsgoCachePaths(configPath)[0]!,
      'stale.txt',
    );
    await writeText(stalePath, 'stale bytes\n');
    process.env.LIMINA_CHECKER_HOST = 'off';

    try {
      const target = createTarget({ configPath, rootDir: fixture.rootDir });
      const result = await createDefaultRunner({ stdio: 'ignore' })({
        ...target,
        args: [commandPath, ...target.args],
        command: process.execPath,
      });

      expect(result.status).toBe(0);
      await expect(readFile(stalePath, 'utf8')).resolves.toBe('stale bytes\n');
    } finally {
      await fixture.cleanup();
    }
  });

  it.skipIf(process.platform !== 'win32')(
    'rejects a descendant Windows junction before cache cleanup',
    async () => {
      const fixture = await createFixture();
      const configPath = fixture.path('packages/app/tsconfig.json');
      await writeText(
        fixture.path('packages/app/package.json'),
        '{"name":"@fixture/app"}\n',
      );
      await writeText(configPath, '{"files":[]}\n');
      await mkdir(fixture.path('external'), { recursive: true });
      const cachePath = createVueTsgoCachePaths(configPath)[0]!;
      await mkdir(cachePath, { recursive: true });
      await symlink(
        fixture.path('external'),
        path.join(cachePath, 'junction'),
        'junction',
      );

      try {
        await expect(
          VueTsgoCacheBatchCoordinator.prepare(
            [createTarget({ configPath, rootDir: fixture.rootDir })],
            { requireValidGeneratedRoute: false },
          ),
        ).rejects.toThrow('symbolic link or junction');
      } finally {
        await fixture.cleanup();
      }
    },
  );
});
