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
    const commandPath = fixture.path('bin/vue-tsgo');
    await writeText(
      fixture.path('packages/app/package.json'),
      '{"name":"@fixture/app"}\n',
    );
    await writeText(configPath, '{"files":[]}\n');
    await writeText(commandPath, '#!/bin/sh\nexit 0\n');
    await chmod(commandPath, 0o755);
    const stalePath = path.join(
      createVueTsgoCachePaths(configPath)[0]!,
      'stale.txt',
    );
    await writeText(stalePath, 'stale bytes\n');
    process.env.LIMINA_CHECKER_HOST = 'off';

    try {
      const result = await createDefaultRunner({ stdio: 'ignore' })({
        ...createTarget({ configPath, rootDir: fixture.rootDir }),
        command: commandPath,
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
