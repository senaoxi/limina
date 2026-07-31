import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const renameFailure = vi.hoisted(() => ({
  code: undefined as string | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();

  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const code = renameFailure.code;
      renameFailure.code = undefined;
      if (code !== undefined) {
        throw Object.assign(new Error(`simulated rename ${code}`), { code });
      }
      return actual.rename(...args);
    },
  };
});

const temporaryDirectories: string[] = [];

async function createFixture() {
  const rootPath = await mkdtemp(path.join(tmpdir(), 'limina-lease-holder-'));
  temporaryDirectories.push(rootPath);
  const owner = {
    hostname: 'test-host',
    pid: process.pid,
    startedAt: '2026-07-31T00:00:00.000Z',
    token: 'test-owner-token',
  };
  return {
    holderPath: path.join(rootPath, 'writer'),
    owner,
    rootPath,
  };
}

afterEach(async () => {
  renameFailure.code = undefined;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('cross-process lease holder publication', () => {
  it.each(['EACCES', 'EBUSY', 'EPERM'])(
    'treats a Windows-style %s rename failure as contention when the holder exists',
    async (code) => {
      const fixture = await createFixture();
      const { publishHolder, releaseOwnedHolder } = await import(
        '../utils/mutation/cross-process-lease-holder'
      );
      await mkdir(fixture.holderPath);
      await writeFile(
        path.join(fixture.holderPath, 'owner.json'),
        `${JSON.stringify(fixture.owner)}\n`,
      );
      renameFailure.code = code;

      await expect(publishHolder(fixture)).resolves.toBe(false);
      await expect(
        access(
          path.join(fixture.rootPath, `.candidate-${fixture.owner.token}`),
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        releaseOwnedHolder(fixture.holderPath, fixture.owner),
      ).resolves.toBeUndefined();
    },
  );

  it('preserves a Windows-style rename failure when no holder exists', async () => {
    const fixture = await createFixture();
    const { publishHolder } = await import(
      '../utils/mutation/cross-process-lease-holder'
    );
    renameFailure.code = 'EPERM';

    await expect(publishHolder(fixture)).rejects.toMatchObject({
      code: 'EPERM',
    });
  });

  it('preserves a non-retryable rename failure', async () => {
    const fixture = await createFixture();
    const { publishHolder } = await import(
      '../utils/mutation/cross-process-lease-holder'
    );
    renameFailure.code = 'EINVAL';

    await expect(publishHolder(fixture)).rejects.toMatchObject({
      code: 'EINVAL',
    });
    await expect(
      access(path.join(fixture.rootPath, `.candidate-${fixture.owner.token}`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
