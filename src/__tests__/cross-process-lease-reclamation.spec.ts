import { spawnSync } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { expect, it, vi } from 'vitest';
import { acquireCrossProcessWriteLease } from '../utils/mutation/cross-process-lease';
import { removeDeadHolder } from '../utils/mutation/cross-process-lease-holder';
import { createSemanticRepairFixture } from './helpers/semantic-repair';

const barrier = vi.hoisted(() => ({
  hook: undefined as
    | undefined
    | ((operation: string, file: string) => Promise<void>),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      await barrier.hook?.('unlink', String(args[0]));
      return actual.unlink(...args);
    },
    rmdir: async (...args: Parameters<typeof actual.rmdir>) => {
      await barrier.hook?.('rmdir', String(args[0]));
      return actual.rmdir(...args);
    },
  };
});

function createGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(['legacy-unlink', 'token-unlink', 'token-rmdir'])(
  'preserves a replacement writer after delayed %s reclamation',
  async (scenario) => {
    const fixture = await createSemanticRepairFixture({ 'package.json': '{}' });
    const holder = fixture.path('.state/leases/generated-artifacts/writer');
    const dead = spawnSync(process.execPath, ['-e', '']);
    expect(dead.status).toBe(0);
    const owner = {
      hostname: hostname(),
      pid: dead.pid,
      startedAt: new Date().toISOString(),
      token: 'dead-owner',
    };
    await mkdir(holder, { recursive: true });
    await writeFile(
      fixture.path(
        '.state/leases/generated-artifacts/writer',
        scenario === 'legacy-unlink' ? 'owner.json' : 'owner-dead-owner.json',
      ),
      JSON.stringify(owner),
    );
    const ready = createGate();
    const resume = createGate();
    barrier.hook = async (operation, file) => {
      if (!file.startsWith(holder) || !scenario.endsWith(operation)) return;
      barrier.hook = undefined;
      ready.resolve();
      await resume.promise;
    };
    let replacement:
      | Awaited<ReturnType<typeof acquireCrossProcessWriteLease>>
      | undefined;
    try {
      const pending = removeDeadHolder(holder);
      await ready.promise;
      replacement = await acquireCrossProcessWriteLease(fixture.root, {
        timeoutMs: 1000,
      });
      const published = await readdir(holder);
      resume.resolve();
      expect(await pending).toBe(false);
      expect(await readdir(holder)).toEqual(published);
      await expect(
        acquireCrossProcessWriteLease(fixture.root, { timeoutMs: 50 }),
      ).rejects.toThrow('Timed out');
      await replacement.release();
      replacement = undefined;
    } finally {
      resume.resolve();
      barrier.hook = undefined;
      await replacement?.release();
      await fixture.cleanup();
    }
  },
);

it.each(['writer', 'readers/abandoned'])(
  'recovers an empty %s slot left between record and directory removal',
  async (slot) => {
    const fixture = await createSemanticRepairFixture({ 'package.json': '{}' });
    await mkdir(fixture.path('.state/leases/generated-artifacts', slot), {
      recursive: true,
    });
    try {
      const lease = await acquireCrossProcessWriteLease(fixture.root, {
        timeoutMs: 1000,
      });
      await lease.release();
      expect(
        await readdir(
          fixture.path('.state/leases/generated-artifacts/readers'),
        ),
      ).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  },
);

it('does not reclaim an unpublished reader candidate while its owner prepares metadata', async () => {
  const fixture = await createSemanticRepairFixture({ 'package.json': '{}' });
  const candidate = fixture.path(
    '.state/leases/generated-artifacts/readers/.candidate-preparing',
  );
  await mkdir(candidate, { recursive: true });
  try {
    const lease = await acquireCrossProcessWriteLease(fixture.root, {
      timeoutMs: 1000,
    });
    expect(await readdir(candidate)).toEqual([]);
    await lease.release();
  } finally {
    await fixture.cleanup();
  }
});
