import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  replaceFileWithRetry,
  ReplacementDriftError,
  RetryableReplacementValidationIoError,
  writeJsonAtomically,
} from '../check-reporting/atomic-writer';
import {
  createLiminaArtifactNamespace,
  resolveArtifactNamespacePath,
} from '../domain/artifacts/namespace';

function retryableError(code: 'EACCES' | 'EBUSY' | 'EPERM'): Error {
  return Object.assign(new Error(code), { code });
}

describe('atomic snapshot writer', () => {
  it('shares one retry budget between validation and replacement failures', async () => {
    const events: string[] = [];
    let validationCount = 0;
    let replaceCount = 0;

    await replaceFileWithRetry('/tmp/source', '/tmp/target', {
      beforeAttempt: async ({ attempt }) => {
        events.push(`validate:${attempt}`);
        validationCount += 1;

        if (attempt === 1) {
          throw new RetryableReplacementValidationIoError(
            'EBUSY',
            'target is temporarily busy',
          );
        }
      },
      replace: async () => {
        events.push(`replace:${replaceCount}`);
        replaceCount += 1;

        if (replaceCount === 1) {
          throw retryableError('EBUSY');
        }
      },
      retryDelaysMs: [0, 0],
    });

    expect(validationCount).toBe(3);
    expect(replaceCount).toBe(2);
    expect(events).toEqual([
      'validate:0',
      'replace:0',
      'validate:1',
      'validate:2',
      'replace:1',
    ]);
  });

  it('keeps retrying through sustained default replacement contention', async () => {
    vi.useFakeTimers();
    const replace = vi
      .fn<(from: string, to: string) => Promise<void>>()
      .mockRejectedValueOnce(retryableError('EPERM'))
      .mockRejectedValueOnce(retryableError('EPERM'))
      .mockRejectedValueOnce(retryableError('EPERM'))
      .mockRejectedValueOnce(retryableError('EPERM'))
      .mockRejectedValueOnce(retryableError('EPERM'))
      .mockResolvedValue();

    try {
      const replacement = replaceFileWithRetry('/tmp/source', '/tmp/target', {
        replace,
      });

      await vi.runAllTimersAsync();
      await expect(replacement).resolves.toBeUndefined();
      expect(replace).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry terminal validation drift', async () => {
    const validate = vi.fn(async () => {
      throw new ReplacementDriftError('content changed');
    });
    const replace = vi.fn(async () => {});

    await expect(
      replaceFileWithRetry('/tmp/source', '/tmp/target', {
        beforeAttempt: validate,
        replace,
        retryDelaysMs: [0, 0, 0],
      }),
    ).rejects.toThrow(/content changed/u);
    expect(validate).toHaveBeenCalledOnce();
    expect(replace).not.toHaveBeenCalled();
  });

  it('uses exclusive temp creation and retries filename collisions', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-atomic-'));
    const namespace = createLiminaArtifactNamespace({ generation: 0, rootDir });
    const targetPath = path.join(namespace.rootDir, 'snapshot.json');
    const collisionPath = path.join(namespace.rootDir, '.collision.tmp');
    const uniquePath = path.join(namespace.rootDir, '.unique.tmp');
    await mkdir(namespace.rootDir, { recursive: true });
    await writeFile(collisionPath, 'occupied');

    try {
      await writeJsonAtomically(
        namespace,
        targetPath,
        { written: true },
        {
          createTempPath: (attempt) =>
            attempt === 0 ? collisionPath : uniquePath,
        },
      );
      expect(await readFile(collisionPath, 'utf8')).toBe('occupied');
      expect(JSON.parse(await readFile(targetPath, 'utf8'))).toEqual({
        written: true,
      });
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('flushes and closes the temp file before rename', async () => {
    const events: string[] = [];
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-atomic-'));
    const namespace = createLiminaArtifactNamespace({ generation: 0, rootDir });
    const targetPath = resolveArtifactNamespacePath(
      namespace,
      'limina-atomic-order.json',
    );
    const tempPath = resolveArtifactNamespacePath(
      namespace,
      'limina-atomic-order.tmp',
    );

    try {
      await writeJsonAtomically(
        namespace,
        targetPath,
        { ok: true },
        {
          createTempPath: () => tempPath,
          openTemp: async (_tempPath, flags) => {
            expect(flags).toBe('wx');
            return {
              close: async () => {
                events.push('close');
              },
              sync: async () => {
                events.push('sync');
              },
              writeFile: async () => {
                events.push('write');
              },
            };
          },
          rename: async () => {
            events.push('rename');
          },
        },
      );

      expect(events).toEqual(['write', 'sync', 'close', 'rename']);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('serializes concurrent writes to the same target path', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-atomic-'));
    const namespace = createLiminaArtifactNamespace({ generation: 0, rootDir });
    const targetPath = path.join(namespace.rootDir, 'snapshot.json');
    const openOrder: number[] = [];
    let releaseFirstRename!: () => void;
    const firstRenameBlocked = new Promise<void>((resolve) => {
      releaseFirstRename = resolve;
    });
    let firstRenameStarted!: () => void;
    const firstRenameReady = new Promise<void>((resolve) => {
      firstRenameStarted = resolve;
    });

    try {
      const first = writeJsonAtomically(
        namespace,
        targetPath,
        { sequence: 1 },
        {
          openTemp: async (tempPath, flags) => {
            openOrder.push(1);
            return open(tempPath, flags);
          },
          rename: async (from, to) => {
            firstRenameStarted();
            await firstRenameBlocked;
            await rename(from, to);
          },
        },
      );
      await firstRenameReady;
      const second = writeJsonAtomically(
        namespace,
        targetPath,
        { sequence: 2 },
        {
          openTemp: async (tempPath, flags) => {
            openOrder.push(2);
            return open(tempPath, flags);
          },
        },
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(openOrder).toEqual([1]);
      releaseFirstRename();
      await Promise.all([first, second]);

      expect(openOrder).toEqual([1, 2]);
      expect(JSON.parse(await readFile(targetPath, 'utf8'))).toEqual({
        sequence: 2,
      });
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('overwrites an existing target without exposing partial JSON', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-atomic-'));
    const namespace = createLiminaArtifactNamespace({ generation: 0, rootDir });
    const targetPath = path.join(namespace.rootDir, 'snapshot.json');
    await mkdir(namespace.rootDir, { recursive: true });
    await writeFile(targetPath, '{"sequence":-1}\n');
    const observations: number[] = [];

    try {
      const reader = (async () => {
        for (let readCount = 0; readCount < 100; readCount += 1) {
          const parsed = JSON.parse(await readFile(targetPath, 'utf8')) as {
            sequence: number;
          };
          observations.push(parsed.sequence);
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      })();
      const writer = (async () => {
        for (let sequence = 0; sequence < 20; sequence += 1) {
          await writeJsonAtomically(namespace, targetPath, {
            payload: 'x'.repeat(16_384),
            sequence,
          });
        }
      })();

      await Promise.all([reader, writer]);

      expect(observations.length).toBeGreaterThan(0);
      expect(
        JSON.parse(await readFile(targetPath, 'utf8')) as { sequence: number },
      ).toMatchObject({ sequence: 19 });
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it.each(['EPERM', 'EACCES', 'EBUSY'] as const)(
    'retries transient %s replacement failures',
    async (code) => {
      const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-atomic-'));
      const namespace = createLiminaArtifactNamespace({
        generation: 0,
        rootDir,
      });
      const targetPath = path.join(namespace.rootDir, 'snapshot.json');
      await mkdir(namespace.rootDir, { recursive: true });
      await writeFile(targetPath, '{"old":true}\n');
      const replace = vi
        .fn<(from: string, to: string) => Promise<void>>()
        .mockRejectedValueOnce(retryableError(code))
        .mockImplementation(rename);

      try {
        await writeJsonAtomically(
          namespace,
          targetPath,
          { new: true },
          { rename: replace, retryDelaysMs: [0, 0] },
        );
        expect(replace).toHaveBeenCalledTimes(2);
        expect(JSON.parse(await readFile(targetPath, 'utf8'))).toEqual({
          new: true,
        });
      } finally {
        await rm(rootDir, { force: true, recursive: true });
      }
    },
  );

  it('keeps the old target valid and never removes or renames it on exhaustion', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-atomic-'));
    const namespace = createLiminaArtifactNamespace({ generation: 0, rootDir });
    const targetPath = path.join(namespace.rootDir, 'snapshot.json');
    await mkdir(namespace.rootDir, { recursive: true });
    await writeFile(targetPath, '{"old":true}\n');
    const renameCalls: [string, string][] = [];
    const removed: string[] = [];

    try {
      await expect(
        writeJsonAtomically(
          namespace,
          targetPath,
          { new: true },
          {
            removeTemp: async (tempPath) => {
              removed.push(tempPath);
              await rm(tempPath, { force: true });
            },
            rename: async (from, to) => {
              renameCalls.push([from, to]);
              throw retryableError('EPERM');
            },
            retryDelaysMs: [0, 0],
          },
        ),
      ).rejects.toMatchObject({ code: 'EPERM' });
      expect(JSON.parse(await readFile(targetPath, 'utf8'))).toEqual({
        old: true,
      });
      expect(
        renameCalls.every(
          ([from, to]) => from !== targetPath && to === targetPath,
        ),
      ).toBe(true);
      expect(removed).toHaveLength(1);
      expect(removed[0]).not.toBe(targetPath);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });
});
