import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
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

      await copyOutputDeclarationInputs(plan, {
        projectRootDir: rootDir,
      });

      expect(existsSync(path.join(rootDir, 'dist/env.d.ts'))).toBe(true);
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
    });
  });
});
