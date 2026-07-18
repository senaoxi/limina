import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toPortablePath } from '../../src/__tests__/helpers/path';
import {
  exists,
  expectLiminaSuccess,
  readJson,
  resolveGeneratedPath,
  runFixtureLimina,
} from '../helpers/assertions';
import { type PreparedFixture, prepareFixture } from '../helpers/fixture';

interface GeneratedSolutionConfig {
  files: unknown[];
  references: { path: string }[];
}

interface GeneratedManifest {
  checkers: {
    typescript: {
      entry: string;
      roots: string[];
      sourceToBuild: Record<
        string,
        {
          kind: 'project' | 'solution';
          path: string;
        }
      >;
      sourceToDts: Record<string, string>;
    };
  };
  generatedBy: string;
  version: number;
}

let fixture: PreparedFixture | undefined;

async function collectPrivateEntries(rootDir: string): Promise<string[]> {
  const matches: string[] = [];

  for (const entryName of await readdir(rootDir)) {
    const entryPath = path.join(rootDir, entryName);
    const entryStat = await lstat(entryPath);

    if (entryName === '.limina' || entryName.endsWith('.tsbuildinfo')) {
      matches.push(toPortablePath(entryPath));
      continue;
    }

    if (entryStat.isDirectory() && !entryStat.isSymbolicLink()) {
      matches.push(...(await collectPrivateEntries(entryPath)));
    }
  }

  return matches.sort();
}

beforeEach(async () => {
  fixture = await prepareFixture('project-references');
});

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

describe('project references public CLI integration', () => {
  it('expands nested solutions and builds both declaration leaves', async () => {
    const preparedFixture = fixture!;
    const rootSolutionPath = preparedFixture.path(
      'repo/.limina/tsconfig/checkers/typescript/solutions/tsconfig.build.json',
    );
    const packageSolutionPath = preparedFixture.path(
      'repo/.limina/tsconfig/checkers/typescript/solutions/packages/app/tsconfig.build.json',
    );
    const libProjectPath = preparedFixture.path(
      'repo/.limina/tsconfig/checkers/typescript/projects/packages/app/tsconfig.lib.dts.json',
    );
    const testProjectPath = preparedFixture.path(
      'repo/.limina/tsconfig/checkers/typescript/projects/packages/app/tsconfig.test.dts.json',
    );
    const checkerEntryPath = preparedFixture.path(
      'repo/.limina/tsconfig/checkers/typescript/tsconfig.build.json',
    );

    const prepareResult = await runFixtureLimina(preparedFixture, [
      'graph',
      'prepare',
    ]);
    expectLiminaSuccess(prepareResult);

    for (const generatedPath of [
      rootSolutionPath,
      packageSolutionPath,
      libProjectPath,
      testProjectPath,
      checkerEntryPath,
    ]) {
      expect(await exists(generatedPath)).toBe(true);
    }

    const rootSolution =
      await readJson<GeneratedSolutionConfig>(rootSolutionPath);
    expect(rootSolution.files).toEqual([]);
    expect(
      rootSolution.references.map((reference) =>
        resolveGeneratedPath(rootSolutionPath, reference.path),
      ),
    ).toEqual([packageSolutionPath]);

    const packageSolution =
      await readJson<GeneratedSolutionConfig>(packageSolutionPath);
    expect(packageSolution.files).toEqual([]);
    expect(
      new Set(
        packageSolution.references.map((reference) =>
          resolveGeneratedPath(packageSolutionPath, reference.path),
        ),
      ),
    ).toEqual(new Set([libProjectPath, testProjectPath]));

    const manifest = await readJson<GeneratedManifest>(
      preparedFixture.path('repo/.limina/manifest.json'),
    );
    expect(manifest.version).toBe(3);
    expect(manifest.generatedBy).toBe('limina');
    expect(manifest.checkers.typescript.entry).toBe(
      '.limina/tsconfig/checkers/typescript/tsconfig.build.json',
    );
    expect(manifest.checkers.typescript.roots).toEqual([
      'packages/app/tsconfig.lib.json',
      'packages/app/tsconfig.test.json',
    ]);
    expect(manifest.checkers.typescript.sourceToBuild).toMatchObject({
      'packages/app/tsconfig.json': {
        kind: 'solution',
        path: '.limina/tsconfig/checkers/typescript/solutions/packages/app/tsconfig.build.json',
      },
      'packages/app/tsconfig.lib.json': {
        kind: 'project',
        path: '.limina/tsconfig/checkers/typescript/projects/packages/app/tsconfig.lib.dts.json',
      },
      'packages/app/tsconfig.test.json': {
        kind: 'project',
        path: '.limina/tsconfig/checkers/typescript/projects/packages/app/tsconfig.test.dts.json',
      },
      'tsconfig.json': {
        kind: 'solution',
        path: '.limina/tsconfig/checkers/typescript/solutions/tsconfig.build.json',
      },
    });
    expect(manifest.checkers.typescript.sourceToDts).toEqual({
      'packages/app/tsconfig.lib.json':
        '.limina/tsconfig/checkers/typescript/projects/packages/app/tsconfig.lib.dts.json',
      'packages/app/tsconfig.test.json':
        '.limina/tsconfig/checkers/typescript/projects/packages/app/tsconfig.test.dts.json',
    });

    const buildResult = await runFixtureLimina(preparedFixture, [
      'checker',
      'build',
    ]);
    expectLiminaSuccess(buildResult);

    const libDeclarationPath = preparedFixture.path(
      'repo/.limina/dts/checkers/typescript/packages/app/lib/index.d.ts',
    );
    const testDeclarationPath = preparedFixture.path(
      'repo/.limina/dts/checkers/typescript/packages/app/test/index.test.d.ts',
    );
    expect(await readFile(libDeclarationPath, 'utf8')).toContain(
      'export declare const libraryValue: "library";',
    );
    expect(await readFile(testDeclarationPath, 'utf8')).toContain(
      'export declare const testValue: "test";',
    );
    expect(
      await exists(
        preparedFixture.path(
          'repo/.limina/tsbuildinfo/checkers/typescript/packages/app/lib.tsbuildinfo',
        ),
      ),
    ).toBe(true);
    expect(
      await exists(
        preparedFixture.path(
          'repo/.limina/tsbuildinfo/checkers/typescript/packages/app/test.tsbuildinfo',
        ),
      ),
    ).toBe(true);
    expect(
      await collectPrivateEntries(preparedFixture.path('repo/packages/app')),
    ).toEqual([]);
  });
});
