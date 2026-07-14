import {
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
import { writeJsonAtomically } from '../check-reporting/atomic-writer';

function retryableError(code: 'EACCES' | 'EBUSY' | 'EPERM'): Error {
  return Object.assign(new Error(code), { code });
}

describe('atomic snapshot writer', () => {
  it('uses exclusive temp creation and retries filename collisions', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-atomic-'));
    const targetPath = path.join(rootDir, 'snapshot.json');
    const collisionPath = path.join(rootDir, '.collision.tmp');
    const uniquePath = path.join(rootDir, '.unique.tmp');
    await writeFile(collisionPath, 'occupied');

    try {
      await writeJsonAtomically(
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

    await writeJsonAtomically(
      '/tmp/limina-atomic-order.json',
      { ok: true },
      {
        createTempPath: () => '/tmp/limina-atomic-order.tmp',
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
  });

  it('serializes concurrent writes to the same target path', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-atomic-'));
    const targetPath = path.join(rootDir, 'snapshot.json');
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
    const targetPath = path.join(rootDir, 'snapshot.json');
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
      for (let sequence = 0; sequence < 20; sequence += 1) {
        await writeJsonAtomically(targetPath, {
          payload: 'x'.repeat(16_384),
          sequence,
        });
      }
      await reader;

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
      const targetPath = path.join(rootDir, 'snapshot.json');
      await writeFile(targetPath, '{"old":true}\n');
      const replace = vi
        .fn<(from: string, to: string) => Promise<void>>()
        .mockRejectedValueOnce(retryableError(code))
        .mockImplementation(rename);

      try {
        await writeJsonAtomically(
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
    const targetPath = path.join(rootDir, 'snapshot.json');
    await writeFile(targetPath, '{"old":true}\n');
    const renameCalls: [string, string][] = [];
    const removed: string[] = [];

    try {
      await expect(
        writeJsonAtomically(
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
