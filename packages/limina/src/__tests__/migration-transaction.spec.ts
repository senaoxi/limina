import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeMigrationWritePlan,
  MigrationTransactionError,
  type MigrationWritePlanItem,
} from '../commands/migration-transaction';
import { toPortablePath } from './helpers/path';

const fixtureRoots = new Set<string>();

async function createFixture(): Promise<string> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-migration-transaction-')),
  );
  fixtureRoots.add(rootDir);
  return rootDir;
}

async function writeText(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

function planItem(
  configPath: string,
  originalContent: string,
  nextContent: string,
  status: MigrationWritePlanItem['status'] = 'modified',
): MigrationWritePlanItem {
  return {
    configPath,
    nextContent,
    originalBytes: Buffer.from(originalContent),
    originalContent,
    status,
  };
}

async function collectTransactionDirectories(
  rootDir: string,
): Promise<string[]> {
  const output: string[] = [];

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (entry.name.startsWith('.limina-migration-')) {
          output.push(entryPath);
        }
        await visit(entryPath);
      }
    }
  }

  await visit(rootDir);
  return output.sort();
}

function retryableError(code: 'EACCES' | 'EBUSY' | 'EPERM'): Error {
  return Object.assign(new Error(code), { code });
}

function restorableMtimeMs(value: { mtimeMs: bigint | number }): number {
  return Math.trunc(Number(value.mtimeMs));
}

function createTransactionDirectoryMock() {
  return vi.fn((prefix: string) => mkdtemp(prefix));
}

afterEach(async () => {
  for (const rootDir of fixtureRoots) {
    await rm(rootDir, { force: true, recursive: true });
  }
  fixtureRoots.clear();
});

describe('migration transaction', () => {
  it('does no physical work when every item is skipped', async () => {
    const makeTransactionDirectory = createTransactionDirectoryMock();
    const openFile = vi.fn(open);
    const replace = vi.fn(rename);
    const result = await executeMigrationWritePlan(
      '/workspace-that-does-not-need-to-exist',
      [
        planItem('/ordinary/tsconfig.json', '{}\n', '{}\n', 'skipped'),
        planItem('/symlink/tsconfig.json', '{}\n', '{}\n', 'skipped'),
        planItem('/hardlink/tsconfig.json', '{}\n', '{}\n', 'skipped'),
      ],
      { makeTransactionDirectory, openFile, replace },
    );

    expect(result.modifiedFiles).toEqual([]);
    expect(result.skippedFiles).toHaveLength(3);
    expect(result.cleanupWarnings).toEqual([]);
    expect(makeTransactionDirectory).not.toHaveBeenCalled();
    expect(openFile).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('leaves ordinary, symlink, and hardlink skipped targets untouched', async () => {
    const rootDir = await createFixture();
    const ordinaryPath = path.join(rootDir, 'ordinary/tsconfig.json');
    const symlinkPath = path.join(rootDir, 'symlink/tsconfig.json');
    const hardlinkPath = path.join(rootDir, 'hardlink/tsconfig.json');
    await writeText(ordinaryPath, 'original\n');
    await mkdir(path.dirname(symlinkPath), { recursive: true });
    await mkdir(path.dirname(hardlinkPath), { recursive: true });
    await symlink(ordinaryPath, symlinkPath);
    await link(ordinaryPath, hardlinkPath);
    const beforeStats = await Promise.all(
      [ordinaryPath, symlinkPath, hardlinkPath].map((filePath) =>
        lstat(filePath, { bigint: true }),
      ),
    );
    const makeTransactionDirectory = createTransactionDirectoryMock();
    const openFile = vi.fn(open);
    const replace = vi.fn(rename);

    const result = await executeMigrationWritePlan(
      rootDir,
      [ordinaryPath, symlinkPath, hardlinkPath].map((filePath) =>
        planItem(filePath, 'original\n', 'original\n', 'skipped'),
      ),
      { makeTransactionDirectory, openFile, replace },
    );
    const afterStats = await Promise.all(
      [ordinaryPath, symlinkPath, hardlinkPath].map((filePath) =>
        lstat(filePath, { bigint: true }),
      ),
    );

    expect(result.modifiedFiles).toEqual([]);
    expect(result.skippedFiles).toEqual([
      ordinaryPath,
      symlinkPath,
      hardlinkPath,
    ]);
    expect(
      afterStats.map(({ ino, mtimeNs, mode, nlink }) => ({
        ino,
        mode,
        mtimeNs,
        nlink,
      })),
    ).toEqual(
      beforeStats.map(({ ino, mtimeNs, mode, nlink }) => ({
        ino,
        mode,
        mtimeNs,
        nlink,
      })),
    );
    expect(makeTransactionDirectory).not.toHaveBeenCalled();
    expect(openFile).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('preserves mode and gives successful content a new transaction result', async () => {
    const rootDir = await createFixture();
    const targetPath = path.join(rootDir, 'package/tsconfig.json');
    await writeText(targetPath, '{"old":true}\n');
    await chmod(targetPath, 0o640);
    const originalStat = await stat(targetPath);

    const result = await executeMigrationWritePlan(rootDir, [
      planItem(targetPath, '{"old":true}\n', '{"new":true}\n'),
    ]);
    const targetStat = await stat(targetPath);

    expect(await readFile(targetPath, 'utf8')).toBe('{"new":true}\n');
    if (process.platform !== 'win32') {
      expect(targetStat.mode & 0o7777).toBe(0o640);
      expect(targetStat.uid).toBe(originalStat.uid);
      expect(targetStat.gid).toBe(originalStat.gid);
    }
    expect(result.modifiedFiles).toEqual([targetPath]);
    expect(await collectTransactionDirectories(rootDir)).toEqual([]);
  });

  it('cleans every parent after a late preparation failure', async () => {
    const rootDir = await createFixture();
    const firstPath = path.join(rootDir, 'a/tsconfig.json');
    const secondPath = path.join(rootDir, 'b/tsconfig.json');
    await writeText(firstPath, 'first\n');
    await writeText(secondPath, 'second\n');

    await expect(
      executeMigrationWritePlan(
        rootDir,
        [
          planItem(firstPath, 'first\n', 'first-next\n'),
          planItem(secondPath, 'second\n', 'second-next\n'),
        ],
        {
          afterPrepareItem: async (_item, index) => {
            if (index === 1) {
              throw new Error('late preparation failure');
            }
          },
        },
      ),
    ).rejects.toThrow(/late preparation failure/u);

    expect(await readFile(firstPath, 'utf8')).toBe('first\n');
    expect(await readFile(secondPath, 'utf8')).toBe('second\n');
    expect(await collectTransactionDirectories(rootDir)).toEqual([]);
  });

  it('cleans all artifacts when the first replacement fails', async () => {
    const rootDir = await createFixture();
    const targetPath = path.join(rootDir, 'package/tsconfig.json');
    await writeText(targetPath, 'original\n');

    await expect(
      executeMigrationWritePlan(
        rootDir,
        [planItem(targetPath, 'original\n', 'next\n')],
        {
          replace: async () => {
            throw new Error('replacement failed');
          },
          retryDelaysMs: [],
        },
      ),
    ).rejects.toThrow(/replacement failed/u);

    expect(await readFile(targetPath, 'utf8')).toBe('original\n');
    expect(await collectTransactionDirectories(rootDir)).toEqual([]);
  });

  it('rolls back earlier replacements and restores the restorable mtime', async () => {
    const rootDir = await createFixture();
    const firstPath = path.join(rootDir, 'a/tsconfig.json');
    const secondPath = path.join(rootDir, 'b/tsconfig.json');
    await writeText(firstPath, 'first\n');
    await writeText(secondPath, 'second\n');
    const originalTime = new Date('2025-01-02T03:04:05.000Z');
    await utimes(firstPath, originalTime, originalTime);
    const originalMtime = restorableMtimeMs(await stat(firstPath));
    let replacementCount = 0;

    await expect(
      executeMigrationWritePlan(
        rootDir,
        [
          planItem(firstPath, 'first\n', 'first-next\n'),
          planItem(secondPath, 'second\n', 'second-next\n'),
        ],
        {
          replace: async (sourcePath, targetPath) => {
            replacementCount += 1;
            if (replacementCount === 2) {
              throw new Error('second replacement failed');
            }
            await rename(sourcePath, targetPath);
          },
          retryDelaysMs: [],
        },
      ),
    ).rejects.toThrow(/second replacement failed/u);

    expect(await readFile(firstPath, 'utf8')).toBe('first\n');
    expect(await readFile(secondPath, 'utf8')).toBe('second\n');
    expect(restorableMtimeMs(await stat(firstPath))).toBe(originalMtime);
    expect(await collectTransactionDirectories(rootDir)).toEqual([]);
  });

  it('preserves external in-place content and only its recovery artifacts', async () => {
    const rootDir = await createFixture();
    const firstPath = path.join(rootDir, 'a/tsconfig.json');
    const secondPath = path.join(rootDir, 'b/tsconfig.json');
    await writeText(firstPath, 'first\n');
    await writeText(secondPath, 'second\n');
    let replacementCount = 0;
    let failure: unknown;

    try {
      await executeMigrationWritePlan(
        rootDir,
        [
          planItem(firstPath, 'first\n', 'first-next\n'),
          planItem(secondPath, 'second\n', 'second-next\n'),
        ],
        {
          replace: async (sourcePath, targetPath) => {
            replacementCount += 1;
            if (replacementCount === 1) {
              await rename(sourcePath, targetPath);
              await writeFile(targetPath, 'external\n');
              return;
            }
            throw new Error('second replacement failed');
          },
          retryDelaysMs: [],
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(MigrationTransactionError);
    expect(String(failure)).toMatch(/recovery backup retained/u);
    expect(await readFile(firstPath, 'utf8')).toBe('external\n');
    expect(await readFile(secondPath, 'utf8')).toBe('second\n');
    const directories = await collectTransactionDirectories(rootDir);
    expect(directories).toHaveLength(1);
    const artifacts = await readdir(directories[0]!);
    expect(artifacts).toContain('0.backup');
    expect(artifacts).not.toContain('1.backup');
  });

  it('revalidates rollback after EBUSY and refuses external in-place content', async () => {
    const rootDir = await createFixture();
    const firstPath = path.join(rootDir, 'a/tsconfig.json');
    const secondPath = path.join(rootDir, 'b/tsconfig.json');
    await writeText(firstPath, 'first\n');
    await writeText(secondPath, 'second\n');
    let replacementCount = 0;
    let failure: unknown;

    try {
      await executeMigrationWritePlan(
        rootDir,
        [
          planItem(firstPath, 'first\n', 'first-next\n'),
          planItem(secondPath, 'second\n', 'second-next\n'),
        ],
        {
          replace: async (sourcePath, targetPath) => {
            replacementCount += 1;
            if (replacementCount === 1) {
              await rename(sourcePath, targetPath);
              return;
            }
            if (replacementCount === 2) {
              throw new Error('second replacement failed');
            }
            await writeFile(targetPath, 'external during rollback retry\n');
            throw retryableError('EBUSY');
          },
          retryDelaysMs: [0],
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(MigrationTransactionError);
    expect(String(failure)).toMatch(/changed|recovery backup retained/u);
    expect(replacementCount).toBe(3);
    expect(await readFile(firstPath, 'utf8')).toBe(
      'external during rollback retry\n',
    );
    const directories = await collectTransactionDirectories(rootDir);
    expect(directories).toHaveLength(1);
    expect(await readdir(directories[0]!)).toContain('0.backup');
  });

  it('revalidates after a retryable commit error and preserves drifted content', async () => {
    const rootDir = await createFixture();
    const targetPath = path.join(rootDir, 'package/tsconfig.json');
    await writeText(targetPath, 'original\n');
    let replaceCount = 0;

    await expect(
      executeMigrationWritePlan(
        rootDir,
        [planItem(targetPath, 'original\n', 'next\n')],
        {
          replace: async () => {
            replaceCount += 1;
            if (replaceCount === 1) {
              await writeFile(targetPath, 'external\n');
              throw retryableError('EBUSY');
            }
          },
          retryDelaysMs: [0, 0],
        },
      ),
    ).rejects.toThrow(/changed/u);

    expect(replaceCount).toBe(1);
    expect(await readFile(targetPath, 'utf8')).toBe('external\n');
  });

  it('shares validation and rename retries within one commit invocation', async () => {
    const rootDir = await createFixture();
    const targetPath = path.join(rootDir, 'package/tsconfig.json');
    await writeText(targetPath, 'original\n');
    let replaceCount = 0;
    let writableOpenCount = 0;

    await executeMigrationWritePlan(
      rootDir,
      [planItem(targetPath, 'original\n', 'next\n')],
      {
        openFile: async (filePath, flags, mode) => {
          if (filePath === targetPath && flags === 'r+') {
            writableOpenCount += 1;
            if (writableOpenCount === 3) {
              throw retryableError('EBUSY');
            }
          }
          return open(filePath, flags, mode);
        },
        replace: async (sourcePath, replacementPath) => {
          replaceCount += 1;
          if (replaceCount === 1) {
            throw retryableError('EBUSY');
          }
          await rename(sourcePath, replacementPath);
        },
        retryDelaysMs: [0, 0],
      },
    );

    expect(replaceCount).toBe(2);
    expect(await readFile(targetPath, 'utf8')).toBe('next\n');
  });

  it('rejects modified symlink and hardlink targets before temp creation', async () => {
    const rootDir = await createFixture();
    const realPath = path.join(rootDir, 'real/tsconfig.json');
    const symlinkPath = path.join(rootDir, 'linked/tsconfig.json');
    const hardlinkPath = path.join(rootDir, 'hard/tsconfig.json');
    await writeText(realPath, 'original\n');
    await mkdir(path.dirname(symlinkPath), { recursive: true });
    await mkdir(path.dirname(hardlinkPath), { recursive: true });
    await symlink(realPath, symlinkPath);
    await link(realPath, hardlinkPath);
    const makeTransactionDirectory = createTransactionDirectoryMock();

    await expect(
      executeMigrationWritePlan(
        rootDir,
        [planItem(symlinkPath, 'original\n', 'next\n')],
        { makeTransactionDirectory },
      ),
    ).rejects.toThrow(/symbolic link|regular config/u);
    await expect(
      executeMigrationWritePlan(
        rootDir,
        [planItem(hardlinkPath, 'original\n', 'next\n')],
        { makeTransactionDirectory },
      ),
    ).rejects.toThrow(/single-link/u);
    expect(makeTransactionDirectory).not.toHaveBeenCalled();
  });

  it('rejects a directory symlink that points outside the workspace', async () => {
    const rootDir = await createFixture();
    const externalRoot = await createFixture();
    const externalPath = path.join(externalRoot, 'tsconfig.json');
    const linkedDirectory = path.join(rootDir, 'linked');
    await writeText(externalPath, 'original\n');
    await symlink(externalRoot, linkedDirectory, 'dir');
    const targetPath = path.join(linkedDirectory, 'tsconfig.json');
    const makeTransactionDirectory = createTransactionDirectoryMock();

    await expect(
      executeMigrationWritePlan(
        rootDir,
        [planItem(targetPath, 'original\n', 'next\n')],
        { makeTransactionDirectory },
      ),
    ).rejects.toThrow(/symbolic link|junction/u);
    expect(await readFile(externalPath, 'utf8')).toBe('original\n');
    expect(makeTransactionDirectory).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== 'win32')(
    'does not bypass a read-only target with rename replacement',
    async () => {
      const rootDir = await createFixture();
      const targetPath = path.join(rootDir, 'package/tsconfig.json');
      await writeText(targetPath, 'original\n');
      await chmod(targetPath, 0o400);
      const makeTransactionDirectory = createTransactionDirectoryMock();

      await expect(
        executeMigrationWritePlan(
          rootDir,
          [planItem(targetPath, 'original\n', 'next\n')],
          { makeTransactionDirectory },
        ),
      ).rejects.toThrow(/writing|EACCES|EPERM/u);
      expect(makeTransactionDirectory).not.toHaveBeenCalled();
      await chmod(targetPath, 0o600);
    },
  );

  it('aggregates post-commit cleanup failures and continues cleanup', async () => {
    const rootDir = await createFixture();
    const targetPath = path.join(rootDir, 'package/tsconfig.json');
    await writeText(targetPath, 'original\n');
    const removePath = vi.fn(async (filePath: string) => {
      if (filePath.endsWith('.backup') || filePath.endsWith('.rollback')) {
        throw new Error(`cannot remove ${filePath}`);
      }
      await rm(filePath, { force: true });
    });

    const result = await executeMigrationWritePlan(
      rootDir,
      [planItem(targetPath, 'original\n', 'next\n')],
      { removePath },
    );

    expect(result.cleanupWarnings.length).toBeGreaterThanOrEqual(2);
    expect(removePath.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(await readFile(targetPath, 'utf8')).toBe('next\n');
  });

  it('aggregates cleanup failures after a pre-commit replacement failure', async () => {
    const rootDir = await createFixture();
    const targetPath = path.join(rootDir, 'package/tsconfig.json');
    await writeText(targetPath, 'original\n');
    const removePath = vi.fn(async (filePath: string) => {
      if (filePath.endsWith('.next') || filePath.endsWith('.backup')) {
        throw new Error(`cannot remove ${filePath}`);
      }
      await rm(filePath, { force: true });
    });
    let failure: unknown;

    try {
      await executeMigrationWritePlan(
        rootDir,
        [planItem(targetPath, 'original\n', 'next\n')],
        {
          removePath,
          replace: async () => {
            throw new Error('replacement failed');
          },
          retryDelaysMs: [],
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(MigrationTransactionError);
    expect((failure as MigrationTransactionError).cleanupFailures).toHaveLength(
      3,
    );
    expect(removePath).toHaveBeenCalledTimes(3);
    expect(await readFile(targetPath, 'utf8')).toBe('original\n');
  });

  it('refuses rollback when the immutable backup mtime drifts', async () => {
    const rootDir = await createFixture();
    const firstPath = path.join(rootDir, 'a/tsconfig.json');
    const secondPath = path.join(rootDir, 'b/tsconfig.json');
    await writeText(firstPath, 'first\n');
    await writeText(secondPath, 'second\n');
    let firstBackupPath = '';
    let replacementCount = 0;
    let failure: unknown;

    try {
      await executeMigrationWritePlan(
        rootDir,
        [
          planItem(firstPath, 'first\n', 'first-next\n'),
          planItem(secondPath, 'second\n', 'second-next\n'),
        ],
        {
          afterPrepareItem: async (_item, index) => {
            if (index === 0) {
              const [directory] = await collectTransactionDirectories(rootDir);
              firstBackupPath = path.join(directory!, '0.backup');
              const driftTime = new Date('2030-01-02T03:04:05.000Z');
              await utimes(firstBackupPath, driftTime, driftTime);
            }
          },
          replace: async (sourcePath, targetPath) => {
            replacementCount += 1;
            if (replacementCount === 2) {
              throw new Error('second replacement failed');
            }
            await rename(sourcePath, targetPath);
          },
          retryDelaysMs: [],
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(MigrationTransactionError);
    expect(String(failure)).toMatch(/mtime changed|recovery backup retained/u);
    expect(await readFile(firstPath, 'utf8')).toBe('first-next\n');
    expect(await readFile(firstBackupPath, 'utf8')).toBe('first\n');
  });

  it('refuses rollback when the prepared rollback temp mtime drifts', async () => {
    const rootDir = await createFixture();
    const firstPath = path.join(rootDir, 'a/tsconfig.json');
    const secondPath = path.join(rootDir, 'b/tsconfig.json');
    await writeText(firstPath, 'first\n');
    await writeText(secondPath, 'second\n');
    let replacementCount = 0;
    let rollbackTempDrifted = false;
    let failure: unknown;

    try {
      await executeMigrationWritePlan(
        rootDir,
        [
          planItem(firstPath, 'first\n', 'first-next\n'),
          planItem(secondPath, 'second\n', 'second-next\n'),
        ],
        {
          readFileBytes: async (filePath) => {
            const bytes = await readFile(filePath);
            if (filePath.endsWith('.rollback') && !rollbackTempDrifted) {
              rollbackTempDrifted = true;
              const driftTime = new Date('2031-01-02T03:04:05.000Z');
              await utimes(filePath, driftTime, driftTime);
            }
            return bytes;
          },
          replace: async (sourcePath, targetPath) => {
            replacementCount += 1;
            if (replacementCount === 2) {
              throw new Error('second replacement failed');
            }
            await rename(sourcePath, targetPath);
          },
          retryDelaysMs: [],
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(MigrationTransactionError);
    expect(String(failure)).toMatch(/mtime changed|recovery backup retained/u);
    expect(rollbackTempDrifted).toBe(true);
    expect(replacementCount).toBe(2);
    expect(await readFile(firstPath, 'utf8')).toBe('first-next\n');
  });

  it('retries transient post-rollback verification access errors', async () => {
    const rootDir = await createFixture();
    const firstPath = path.join(rootDir, 'a/tsconfig.json');
    const secondPath = path.join(rootDir, 'b/tsconfig.json');
    await writeText(firstPath, 'first\n');
    await writeText(secondPath, 'second\n');
    let replacementCount = 0;
    let rollbackInstalled = false;
    let transientReadCount = 0;

    await expect(
      executeMigrationWritePlan(
        rootDir,
        [
          planItem(firstPath, 'first\n', 'first-next\n'),
          planItem(secondPath, 'second\n', 'second-next\n'),
        ],
        {
          readFileBytes: async (filePath) => {
            if (
              rollbackInstalled &&
              filePath === firstPath &&
              transientReadCount < 2
            ) {
              transientReadCount += 1;
              throw retryableError('EBUSY');
            }
            return readFile(filePath);
          },
          replace: async (sourcePath, targetPath) => {
            replacementCount += 1;
            if (replacementCount === 2) {
              throw new Error('second replacement failed');
            }
            await rename(sourcePath, targetPath);
            if (replacementCount === 3) {
              rollbackInstalled = true;
            }
          },
          retryDelaysMs: [0, 0],
        },
      ),
    ).rejects.toThrow(/second replacement failed/u);

    expect(transientReadCount).toBe(2);
    expect(await readFile(firstPath, 'utf8')).toBe('first\n');
    expect(await readFile(secondPath, 'utf8')).toBe('second\n');
    expect(await collectTransactionDirectories(rootDir)).toEqual([]);
  });

  it('keeps an immutable backup when rollback post-verification fails', async () => {
    const rootDir = await createFixture();
    const firstPath = path.join(rootDir, 'a/tsconfig.json');
    const secondPath = path.join(rootDir, 'b/tsconfig.json');
    await writeText(firstPath, 'first\n');
    await writeText(secondPath, 'second\n');
    let replaceCount = 0;
    let failure: unknown;

    try {
      await executeMigrationWritePlan(
        rootDir,
        [
          planItem(firstPath, 'first\n', 'first-next\n'),
          planItem(secondPath, 'second\n', 'second-next\n'),
        ],
        {
          replace: async (sourcePath, targetPath) => {
            replaceCount += 1;
            if (replaceCount === 2) {
              throw new Error('second replacement failed');
            }
            await rename(sourcePath, targetPath);
            if (replaceCount === 3) {
              await writeFile(targetPath, 'post-verify external\n');
            }
          },
          retryDelaysMs: [],
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(MigrationTransactionError);
    expect(String(failure)).toMatch(/recovery backup retained/u);
    expect(await readFile(firstPath, 'utf8')).toBe('post-verify external\n');
    const directories = await collectTransactionDirectories(rootDir);
    expect(directories).toHaveLength(1);
    expect(await readdir(directories[0]!)).toContain('0.backup');
  });

  it('records a stable physical identity for regular files', async () => {
    const rootDir = await createFixture();
    const targetPath = path.join(rootDir, 'package/tsconfig.json');
    await writeText(targetPath, 'original\n');
    const before = await lstat(targetPath, { bigint: true });

    await executeMigrationWritePlan(rootDir, [
      planItem(targetPath, 'original\n', 'next\n'),
    ]);

    const after = await lstat(targetPath, { bigint: true });
    expect(after.ino).not.toBe(before.ino);
    expect(after.nlink).toBe(1n);
  });

  it('allows one case alias but rejects duplicate aliases on insensitive filesystems', async () => {
    const rootDir = await createFixture();
    const targetPath = toPortablePath(
      path.join(rootDir, 'Package/tsconfig.json'),
    );
    const aliasPath = toPortablePath(
      path.join(rootDir, 'package/tsconfig.json'),
    );
    await writeText(targetPath, 'original\n');

    let aliasCanonicalPath: string;
    try {
      aliasCanonicalPath = await realpath(aliasPath);
    } catch {
      return;
    }

    if ((await realpath(targetPath)) !== aliasCanonicalPath) {
      return;
    }

    await executeMigrationWritePlan(rootDir, [
      planItem(aliasPath, 'original\n', 'next\n'),
    ]);
    expect(await readFile(targetPath, 'utf8')).toBe('next\n');

    await expect(
      executeMigrationWritePlan(rootDir, [
        planItem(targetPath, 'next\n', 'next-again\n'),
        planItem(aliasPath, 'next\n', 'alias-next\n'),
      ]),
    ).rejects.toThrow(
      /multiple logical paths[\s\S]*package\/tsconfig\.json[\s\S]*Package\/tsconfig\.json/u,
    );
  });
});
