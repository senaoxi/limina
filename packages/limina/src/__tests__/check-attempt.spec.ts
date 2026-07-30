import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import path from 'pathe';
import { describe, expect, it, vi } from 'vitest';
import {
  CHECK_ISSUE_SNAPSHOT_VERSION,
  type CheckIssueSnapshot,
  writeCheckIssueSnapshotOnly,
} from '../check-reporting/snapshot';
import { createLiminaArtifactNamespace } from '../domain/artifacts/namespace';
import {
  abortCheckAttempt,
  completeCheckAttempt,
  getCheckAttemptPaths,
  publishCheckAttempt,
} from '../source-check/snapshot/check-attempt-io';
import { queryLatestCheckAttempt } from '../source-check/snapshot/check-attempt-query';
import { cleanupAttemptRetention } from '../source-check/snapshot/check-attempt-retention';

vi.mock(
  '../source-check/snapshot/check-attempt-retention',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../source-check/snapshot/check-attempt-retention')
      >();
    return {
      ...actual,
      cleanupAttemptRetention: vi.fn(actual.cleanupAttemptRetention),
    };
  },
);

const execFileAsync = promisify(execFile);

async function withTempRoot(
  run: (rootDir: string) => Promise<void>,
): Promise<void> {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-attempt-'));
  try {
    await run(rootDir);
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
}

function createSnapshot(label: string): CheckIssueSnapshot {
  return {
    command: `limina check ${label}`,
    createdAt: new Date().toISOString(),
    issues: [],
    status: 'completed',
    version: CHECK_ISSUE_SNAPSHOT_VERSION,
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

describe('check attempt freshness', () => {
  it('publishes only metadata and reports a started attempt as running', async () => {
    await withTempRoot(async (rootDir) => {
      const namespace = createLiminaArtifactNamespace({
        generation: 0,
        rootDir,
      });
      const attempt = await publishCheckAttempt({
        command: 'limina check',
        namespace,
      });

      await expect(queryLatestCheckAttempt(rootDir)).resolves.toMatchObject({
        snapshot: null,
        state: 'running',
      });
      const paths = getCheckAttemptPaths(rootDir);
      await expect(
        readFile(
          path.join(
            paths.attemptsDir,
            attempt.latest.attemptId,
            'last-run.json',
          ),
          'utf8',
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('fails closed for corrupt latest-attempt metadata and refuses a new sequence', async () => {
    await withTempRoot(async (rootDir) => {
      const namespace = createLiminaArtifactNamespace({
        generation: 0,
        rootDir,
      });
      const paths = getCheckAttemptPaths(rootDir);
      await mkdir(paths.checkDir, { recursive: true });
      await writeFile(paths.latestAttempt, '{broken\n');

      await expect(queryLatestCheckAttempt(rootDir)).resolves.toMatchObject({
        snapshot: null,
        state: 'latest-attempt-corrupt',
      });
      await expect(
        publishCheckAttempt({ command: 'limina check', namespace }),
      ).rejects.toThrow('cannot be allocated safely');
    });
  });

  it('fails closed when latest-attempt is missing but completed metadata exists', async () => {
    await withTempRoot(async (rootDir) => {
      const namespace = createLiminaArtifactNamespace({
        generation: 0,
        rootDir,
      });
      const attempt = await publishCheckAttempt({
        command: 'limina check',
        namespace,
      });
      await completeCheckAttempt({
        attempt,
        namespace,
        snapshot: createSnapshot('completed'),
        sourceSnapshotPersisted: false,
        writeSnapshot: writeCheckIssueSnapshotOnly,
      });
      await rm(getCheckAttemptPaths(rootDir).latestAttempt);

      await expect(queryLatestCheckAttempt(rootDir)).resolves.toMatchObject({
        snapshot: null,
        state: 'latest-attempt-corrupt',
      });
    });
  });

  it('fails closed on a torn completed pair and a higher sequence repairs it', async () => {
    await withTempRoot(async (rootDir) => {
      const namespace = createLiminaArtifactNamespace({
        generation: 0,
        rootDir,
      });
      const first = await publishCheckAttempt({
        command: 'limina check first',
        namespace,
      });
      const firstSnapshot = createSnapshot('first');
      await completeCheckAttempt({
        attempt: first,
        namespace,
        snapshot: firstSnapshot,
        sourceSnapshotPersisted: false,
        writeSnapshot: writeCheckIssueSnapshotOnly,
      });
      await expect(queryLatestCheckAttempt(rootDir)).resolves.toMatchObject({
        snapshot: firstSnapshot,
        state: 'completed',
      });

      const paths = getCheckAttemptPaths(rootDir);
      await writeFile(
        paths.lastRun,
        `${JSON.stringify(createSnapshot('torn'), null, 2)}\n`,
      );
      await expect(queryLatestCheckAttempt(rootDir)).resolves.toMatchObject({
        snapshot: null,
        state: 'completed-inconsistent',
      });

      const second = await publishCheckAttempt({
        command: 'limina check second',
        namespace,
      });
      const secondSnapshot = createSnapshot('second');
      await completeCheckAttempt({
        attempt: second,
        namespace,
        snapshot: secondSnapshot,
        sourceSnapshotPersisted: false,
        writeSnapshot: writeCheckIssueSnapshotOnly,
      });
      await expect(queryLatestCheckAttempt(rootDir)).resolves.toMatchObject({
        snapshot: secondSnapshot,
        state: 'completed',
      });
    });
  });

  it('does not let a superseded completion replace the latest inventory', async () => {
    await withTempRoot(async (rootDir) => {
      const namespace = createLiminaArtifactNamespace({
        generation: 0,
        rootDir,
      });
      const first = await publishCheckAttempt({
        command: 'limina check first',
        namespace,
      });
      const second = await publishCheckAttempt({
        command: 'limina check second',
        namespace,
      });
      const secondSnapshot = createSnapshot('second');
      await completeCheckAttempt({
        attempt: second,
        namespace,
        snapshot: secondSnapshot,
        sourceSnapshotPersisted: false,
        writeSnapshot: writeCheckIssueSnapshotOnly,
      });
      const oldWriter = vi.fn(writeCheckIssueSnapshotOnly);
      await completeCheckAttempt({
        attempt: first,
        namespace,
        snapshot: createSnapshot('first'),
        sourceSnapshotPersisted: false,
        writeSnapshot: oldWriter,
      });

      expect(oldWriter).not.toHaveBeenCalled();
      await expect(queryLatestCheckAttempt(rootDir)).resolves.toMatchObject({
        snapshot: secondSnapshot,
        state: 'completed',
      });
      const firstStatus = JSON.parse(
        await readFile(
          path.join(
            getCheckAttemptPaths(rootDir).attemptsDir,
            first.latest.attemptId,
            'status.json',
          ),
          'utf8',
        ),
      ) as { inventoryPublished: boolean; status: string };
      expect(firstStatus).toMatchObject({
        inventoryPublished: false,
        status: 'completed',
      });
    });
  });

  it('records persistence and infrastructure failures without exposing old issues', async () => {
    await withTempRoot(async (rootDir) => {
      const namespace = createLiminaArtifactNamespace({
        generation: 0,
        rootDir,
      });
      const persistenceAttempt = await publishCheckAttempt({
        command: 'limina check persistence',
        namespace,
      });
      await expect(
        completeCheckAttempt({
          attempt: persistenceAttempt,
          namespace,
          snapshot: createSnapshot('persistence'),
          sourceSnapshotPersisted: true,
          writeSnapshot: async () => {
            throw new Error('disk unavailable');
          },
        }),
      ).rejects.toThrow('disk unavailable');
      await expect(queryLatestCheckAttempt(rootDir)).resolves.toMatchObject({
        snapshot: null,
        state: 'persistence-failed',
      });

      const abortedAttempt = await publishCheckAttempt({
        command: 'limina check aborted',
        namespace,
      });
      await abortCheckAttempt({
        attempt: abortedAttempt,
        error: new Error('scheduler failed'),
        namespace,
      });
      await expect(queryLatestCheckAttempt(rootDir)).resolves.toMatchObject({
        snapshot: null,
        state: 'aborted',
      });
    });
  });

  it('keeps cleanup failure secondary to a successfully published inventory', async () => {
    await withTempRoot(async (rootDir) => {
      const namespace = createLiminaArtifactNamespace({
        generation: 0,
        rootDir,
      });
      const attempt = await publishCheckAttempt({
        command: 'limina check',
        namespace,
      });
      const warn = vi.fn();
      vi.mocked(cleanupAttemptRetention).mockRejectedValueOnce(
        new Error('cleanup unavailable'),
      );

      await expect(
        completeCheckAttempt({
          attempt,
          namespace,
          snapshot: createSnapshot('cleanup-warning'),
          sourceSnapshotPersisted: false,
          warn,
          writeSnapshot: writeCheckIssueSnapshotOnly,
        }),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('cleanup unavailable'),
      );
      await expect(queryLatestCheckAttempt(rootDir)).resolves.toMatchObject({
        state: 'completed',
      });
    });
  });

  it('retains pointers, newest, recent, live, and unknown attempts while collecting old terminal and dead attempts', async () => {
    await withTempRoot(async (rootDir) => {
      const namespace = createLiminaArtifactNamespace({
        generation: 0,
        rootDir,
      });
      const paths = getCheckAttemptPaths(rootDir);
      const oldStartedAt = new Date(
        Date.now() - 31 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const recentStartedAt = new Date().toISOString();
      for (let sequence = 1; sequence <= 40; sequence += 1) {
        const attemptId = `attempt-${sequence}`;
        const attemptDir = path.join(paths.attemptsDir, attemptId);
        const startedAt = sequence === 2 ? recentStartedAt : oldStartedAt;
        const owner =
          sequence === 4
            ? { hostname: 'unknown-host', pid: 1 }
            : {
                hostname: hostname(),
                pid: sequence === 5 ? 2_147_483_647 : process.pid,
              };
        await writeJson(path.join(attemptDir, 'started.json'), {
          version: 1,
          attemptId,
          command: 'limina check',
          owner: {
            ...owner,
            startedAt,
            token: `token-${sequence}`,
          },
          sequence,
          startedAt,
        });
        if (![3, 4, 5].includes(sequence)) {
          await writeJson(path.join(attemptDir, 'status.json'), {
            version: 1,
            attemptId,
            finishedAt: oldStartedAt,
            inventoryPublished: false,
            sequence,
            status: 'aborted',
          });
        }
      }
      await writeJson(paths.latestAttempt, {
        version: 1,
        attemptId: 'attempt-40',
        sequence: 40,
        startedAt: oldStartedAt,
      });
      await writeJson(paths.latestCompleted, {
        version: 1,
        attemptId: 'attempt-1',
        sequence: 1,
        snapshotCreatedAt: oldStartedAt,
        snapshotHash: 'hash',
      });

      await cleanupAttemptRetention(namespace);

      for (const retained of [1, 2, 3, 4, 9, 40]) {
        await expect(
          readFile(
            path.join(paths.attemptsDir, `attempt-${retained}`, 'started.json'),
            'utf8',
          ),
        ).resolves.toContain(`attempt-${retained}`);
      }
      for (const removed of [5, 6, 7, 8]) {
        await expect(
          readFile(
            path.join(paths.attemptsDir, `attempt-${removed}`, 'started.json'),
            'utf8',
          ),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      }
    });
  });

  it.each(['human', 'json', 'ndjson'] as const)(
    'reports unavailable freshness explicitly in %s CLI output and exits one',
    async (format) => {
      await withTempRoot(async (rootDir) => {
        const namespace = createLiminaArtifactNamespace({
          generation: 0,
          rootDir,
        });
        const attempt = await publishCheckAttempt({
          command: 'limina check',
          namespace,
        });
        await abortCheckAttempt({
          attempt,
          error: new Error('scheduler failed'),
          namespace,
        });
        await writeFile(
          path.join(rootDir, 'limina.config.mjs'),
          'export default {};\n',
        );
        await writeFile(
          path.join(rootDir, 'pnpm-workspace.yaml'),
          'packages: []\n',
        );
        const cliPath = fileURLToPath(
          new URL('../../bin/limina.js', import.meta.url),
        );

        let failure: (Error & { code?: number; stdout?: string }) | undefined;
        try {
          await execFileAsync(
            process.execPath,
            [
              cliPath,
              '--config',
              path.join(rootDir, 'limina.config.mjs'),
              'check',
              '--issues',
              '--format',
              format,
            ],
            { cwd: rootDir, env: { ...process.env, CI: 'true' } },
          );
        } catch (error) {
          failure = error as Error & { code?: number; stdout?: string };
        }

        expect(failure?.code).toBe(1);
        const stdout = failure?.stdout ?? '';
        if (format === 'human') {
          expect(stdout).toContain('Issue inventory unavailable');
          expect(stdout).toContain('latest check attempt was aborted');
        } else {
          expect(JSON.parse(stdout)).toMatchObject({
            issueCount: 0,
            issues: [],
            status: 'aborted',
            ...(format === 'ndjson' ? { type: 'inventory-status' } : {}),
          });
        }
      });
    },
  );
});
