import { existsSync } from 'node:fs';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  copyOutputDeclarationInputs,
  createOutputDeclarationCopyPlan,
  isDeclarationInputFile,
  OutputDeclarationCopyError,
} from '../typecheck/output-declarations';

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

async function withTempRoot<T>(callback: (rootDir: string) => Promise<T>) {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-output-dts-')),
  );

  try {
    return await callback(rootDir);
  } finally {
    await rm(rootDir, {
      force: true,
      recursive: true,
    });
  }
}

describe('output declaration copy planning', () => {
  it('matches declaration input file extensions', () => {
    expect(isDeclarationInputFile('env.d.ts')).toBe(true);
    expect(isDeclarationInputFile('env.d.cts')).toBe(true);
    expect(isDeclarationInputFile('env.d.mts')).toBe(true);
    expect(isDeclarationInputFile('env.ts')).toBe(false);
  });

  it('plans .d.ts, .d.cts, and .d.mts copies under rootDir', async () => {
    await withTempRoot(async (rootDir) => {
      const plan = createOutputDeclarationCopyPlan({
        fileNames: [
          path.join(rootDir, 'src/env.d.ts'),
          path.join(rootDir, 'src/cjs/env.d.cts'),
          path.join(rootDir, 'src/esm/env.d.mts'),
        ],
        outDir: path.join(rootDir, 'dist'),
        projectRootDir: rootDir,
        rootDir: path.join(rootDir, 'src'),
      });

      expect(
        plan.entries.map((entry) =>
          path.relative(rootDir, entry.targetPath).replaceAll(path.sep, '/'),
        ),
      ).toEqual(['dist/cjs/env.d.cts', 'dist/env.d.ts', 'dist/esm/env.d.mts']);
      expect(plan.problems).toEqual([]);
    });
  });

  it('excludes node_modules declaration inputs by path segment', async () => {
    await withTempRoot(async (rootDir) => {
      const plan = createOutputDeclarationCopyPlan({
        fileNames: [path.join(rootDir, 'node_modules/pkg/client.d.ts')],
        outDir: path.join(rootDir, 'dist'),
        projectRootDir: rootDir,
        rootDir: path.join(rootDir, 'src'),
      });

      expect(plan.entries).toEqual([]);
      expect(plan.problems).toEqual([]);
    });
  });

  it('skips declaration inputs already inside outDir', async () => {
    await withTempRoot(async (rootDir) => {
      const plan = createOutputDeclarationCopyPlan({
        fileNames: [path.join(rootDir, 'dist/env.d.ts')],
        outDir: path.join(rootDir, 'dist'),
        projectRootDir: rootDir,
        rootDir,
      });

      expect(plan.entries).toEqual([]);
      expect(plan.problems).toEqual([]);
    });
  });

  it('warns for local declaration inputs outside rootDir', async () => {
    await withTempRoot(async (rootDir) => {
      const plan = createOutputDeclarationCopyPlan({
        fileNames: [path.join(rootDir, 'types/client.d.ts')],
        outDir: path.join(rootDir, 'dist'),
        projectRootDir: rootDir,
        rootDir: path.join(rootDir, 'src'),
      });

      expect(plan.entries).toEqual([]);
      expect(plan.problems).toMatchObject([
        {
          reason: 'outside-root',
          severity: 'warning',
        },
      ]);
    });
  });

  it('does not create escaped targets from normalized parent segments', async () => {
    await withTempRoot(async (rootDir) => {
      const plan = createOutputDeclarationCopyPlan({
        fileNames: [path.join(rootDir, 'src/../../outside.d.ts')],
        outDir: path.join(rootDir, 'dist'),
        projectRootDir: rootDir,
        rootDir: path.join(rootDir, 'src'),
      });

      expect(plan.entries).toEqual([]);
      expect(plan.problems).toMatchObject([
        {
          reason: 'outside-root',
          severity: 'warning',
        },
      ]);
    });
  });
});

describe('output declaration copying', () => {
  it('copies planned declaration inputs', async () => {
    await withTempRoot(async (rootDir) => {
      await writeText(
        path.join(rootDir, 'src/env.d.ts'),
        'declare const x: 1;\n',
      );
      const plan = createOutputDeclarationCopyPlan({
        fileNames: [path.join(rootDir, 'src/env.d.ts')],
        outDir: path.join(rootDir, 'dist'),
        projectRootDir: rootDir,
        rootDir: path.join(rootDir, 'src'),
      });

      await copyOutputDeclarationInputs(plan, {
        projectRootDir: rootDir,
      });

      await expect(
        readFile(path.join(rootDir, 'dist/env.d.ts'), 'utf8'),
      ).resolves.toBe('declare const x: 1;\n');
    });
  });

  it('skips identical existing targets', async () => {
    await withTempRoot(async (rootDir) => {
      await writeText(
        path.join(rootDir, 'src/env.d.ts'),
        'declare const x: 1;\n',
      );
      await writeText(
        path.join(rootDir, 'dist/env.d.ts'),
        'declare const x: 1;\n',
      );
      const plan = createOutputDeclarationCopyPlan({
        fileNames: [path.join(rootDir, 'src/env.d.ts')],
        outDir: path.join(rootDir, 'dist'),
        projectRootDir: rootDir,
        rootDir: path.join(rootDir, 'src'),
      });
      await chmod(path.join(rootDir, 'dist/env.d.ts'), 0o640);
      const before = await stat(path.join(rootDir, 'dist/env.d.ts'));

      await copyOutputDeclarationInputs(plan, {
        projectRootDir: rootDir,
      });

      const after = await stat(path.join(rootDir, 'dist/env.d.ts'));
      expect(after.ino).toBe(before.ino);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(after.mode & 0o7777).toBe(before.mode & 0o7777);
      await expect(
        readFile(path.join(rootDir, 'dist/env.d.ts'), 'utf8'),
      ).resolves.toBe('declare const x: 1;\n');
    });
  });

  it('fails on differing existing targets', async () => {
    await withTempRoot(async (rootDir) => {
      await writeText(
        path.join(rootDir, 'src/env.d.ts'),
        'declare const x: 1;\n',
      );
      await writeText(
        path.join(rootDir, 'dist/env.d.ts'),
        'declare const x: 2;\n',
      );
      const plan = createOutputDeclarationCopyPlan({
        fileNames: [path.join(rootDir, 'src/env.d.ts')],
        outDir: path.join(rootDir, 'dist'),
        projectRootDir: rootDir,
        rootDir: path.join(rootDir, 'src'),
      });

      await expect(
        copyOutputDeclarationInputs(plan, {
          projectRootDir: rootDir,
        }),
      ).rejects.toBeInstanceOf(OutputDeclarationCopyError);
      await expect(
        readFile(path.join(rootDir, 'dist/env.d.ts'), 'utf8'),
      ).resolves.toBe('declare const x: 2;\n');
    });
  });

  it('performs zero mutation when any entry conflicts', async () => {
    await withTempRoot(async (rootDir) => {
      await writeText(
        path.join(rootDir, 'src/a/env.d.ts'),
        'declare const a: 1;\n',
      );
      await writeText(
        path.join(rootDir, 'src/b/env.d.ts'),
        'declare const b: 1;\n',
      );
      await writeText(
        path.join(rootDir, 'dist/b/env.d.ts'),
        'declare const conflict: 1;\n',
      );
      const plan = createOutputDeclarationCopyPlan({
        fileNames: [
          path.join(rootDir, 'src/a/env.d.ts'),
          path.join(rootDir, 'src/b/env.d.ts'),
        ],
        outDir: path.join(rootDir, 'dist'),
        projectRootDir: rootDir,
        rootDir: path.join(rootDir, 'src'),
      });

      await expect(
        copyOutputDeclarationInputs(plan, { projectRootDir: rootDir }),
      ).rejects.toBeInstanceOf(OutputDeclarationCopyError);
      expect(existsSync(path.join(rootDir, 'dist/a'))).toBe(false);
      await expect(
        readFile(path.join(rootDir, 'dist/b/env.d.ts'), 'utf8'),
      ).resolves.toBe('declare const conflict: 1;\n');
    });
  });

  it('uses exclusive publication when a missing target appears after preflight', async () => {
    await withTempRoot(async (rootDir) => {
      const targetPath = path.join(rootDir, 'dist/env.d.ts');
      await writeText(
        path.join(rootDir, 'src/env.d.ts'),
        'declare const source: 1;\n',
      );
      await mkdir(path.dirname(targetPath), { recursive: true });
      const plan = createOutputDeclarationCopyPlan({
        fileNames: [path.join(rootDir, 'src/env.d.ts')],
        outDir: path.join(rootDir, 'dist'),
        projectRootDir: rootDir,
        rootDir: path.join(rootDir, 'src'),
      });

      await expect(
        copyOutputDeclarationInputs(plan, {
          beforePublishForTesting: async () => {
            await writeFile(targetPath, 'concurrent user bytes\n');
          },
          projectRootDir: rootDir,
        }),
      ).rejects.toThrow('EEXIST');
      await expect(readFile(targetPath, 'utf8')).resolves.toBe(
        'concurrent user bytes\n',
      );
    });
  });

  it('does not delete a concurrent replacement during rollback', async () => {
    await withTempRoot(async (rootDir) => {
      const firstTarget = path.join(rootDir, 'dist/a.d.ts');
      const secondTarget = path.join(rootDir, 'dist/b.d.ts');
      await writeText(
        path.join(rootDir, 'src/a.d.ts'),
        'declare const a: 1;\n',
      );
      await writeText(
        path.join(rootDir, 'src/b.d.ts'),
        'declare const b: 1;\n',
      );
      await mkdir(path.dirname(firstTarget), { recursive: true });
      const plan = createOutputDeclarationCopyPlan({
        fileNames: [
          path.join(rootDir, 'src/a.d.ts'),
          path.join(rootDir, 'src/b.d.ts'),
        ],
        outDir: path.join(rootDir, 'dist'),
        projectRootDir: rootDir,
        rootDir: path.join(rootDir, 'src'),
      });

      await expect(
        copyOutputDeclarationInputs(plan, {
          beforePublishForTesting: async (_entry, index) => {
            if (index !== 1) return;
            await rename(firstTarget, path.join(rootDir, 'first-owned-moved'));
            await writeFile(firstTarget, 'concurrent replacement bytes\n');
            await writeFile(secondTarget, 'concurrent conflict bytes\n');
          },
          projectRootDir: rootDir,
        }),
      ).rejects.toBeInstanceOf(AggregateError);
      await expect(readFile(firstTarget, 'utf8')).resolves.toBe(
        'concurrent replacement bytes\n',
      );
      await expect(readFile(secondTarget, 'utf8')).resolves.toBe(
        'concurrent conflict bytes\n',
      );
    });
  });

  it('keeps regular-file nlink drift from granting rollback ownership', async () => {
    await withTempRoot(async (rootDir) => {
      const firstTarget = path.join(rootDir, 'dist/a.d.ts');
      const secondTarget = path.join(rootDir, 'dist/b.d.ts');
      await writeText(
        path.join(rootDir, 'src/a.d.ts'),
        'declare const a: 1;\n',
      );
      await writeText(
        path.join(rootDir, 'src/b.d.ts'),
        'declare const b: 1;\n',
      );
      await mkdir(path.dirname(firstTarget), { recursive: true });
      const plan = createOutputDeclarationCopyPlan({
        fileNames: [
          path.join(rootDir, 'src/a.d.ts'),
          path.join(rootDir, 'src/b.d.ts'),
        ],
        outDir: path.join(rootDir, 'dist'),
        projectRootDir: rootDir,
        rootDir: path.join(rootDir, 'src'),
      });

      await expect(
        copyOutputDeclarationInputs(plan, {
          beforePublishForTesting: async (_entry, index) => {
            if (index !== 1) return;
            await link(firstTarget, path.join(rootDir, 'owned-hardlink.d.ts'));
            await writeFile(secondTarget, 'concurrent conflict bytes\n');
          },
          projectRootDir: rootDir,
        }),
      ).rejects.toBeInstanceOf(AggregateError);
      await expect(readFile(firstTarget, 'utf8')).resolves.toBe(
        'declare const a: 1;\n',
      );
    });
  });

  it('rejects declaration output links without touching external bytes', async () => {
    await withTempRoot(async (rootDir) => {
      const markerPath = path.join(rootDir, 'external/marker.txt');
      await writeText(
        path.join(rootDir, 'src/env.d.ts'),
        'declare const source: 1;\n',
      );
      await writeText(markerPath, 'external marker bytes\n');
      await mkdir(path.join(rootDir, 'dist'), { recursive: true });
      await symlink(
        path.join(rootDir, 'external'),
        path.join(rootDir, 'dist/nested-link'),
      );
      const plan = createOutputDeclarationCopyPlan({
        fileNames: [path.join(rootDir, 'src/env.d.ts')],
        outDir: path.join(rootDir, 'dist'),
        projectRootDir: rootDir,
        rootDir: path.join(rootDir, 'src'),
      });

      await expect(
        copyOutputDeclarationInputs(plan, { projectRootDir: rootDir }),
      ).rejects.toThrow('symbolic link or junction');
      await expect(readFile(markerPath, 'utf8')).resolves.toBe(
        'external marker bytes\n',
      );
    });
  });
});
