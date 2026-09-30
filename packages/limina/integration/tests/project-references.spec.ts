import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toPortablePath } from '../../src/__tests__/helpers/path';
import {
  expectLiminaSuccess,
  isExists,
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
    tsc: {
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

const fixtureState: { current: PreparedFixture | undefined } = {
  current: undefined,
};

async function collectPrivateEntries(rootDirectory: string): Promise<string[]> {
  const matches: string[] = [];

  const entryNames = await readdir(rootDirectory);
  for (const entryName of entryNames) {
    const entryPath = path.join(rootDirectory, entryName);
    const entryStat = await lstat(entryPath);

    if (entryName === '.limina' || entryName.endsWith('.tsbuildinfo')) {
      matches.push(toPortablePath(entryPath));
      continue;
    }

    if (entryStat.isDirectory() && !entryStat.isSymbolicLink()) {
      matches.push(...(await collectPrivateEntries(entryPath)));
    }
  }

  return matches.sort(
    (left, right) => Number(left > right) - Number(left < right),
  );
}

beforeEach(async () => {
  fixtureState.current = await prepareFixture('project-references');
});

afterEach(async () => {
  await fixtureState.current?.cleanup();
  fixtureState.current = undefined;
});

describe('project references public CLI integration', () => {
  it('expands nested solutions and builds both declaration leaves', async () => {
    const preparedFixture = fixtureState.current!;
    const rootSolutionPath = preparedFixture.path(
      'repo/.limina/tsconfig/checkers/tsc/solutions/tsconfig.build.json',
    );
    const packageSolutionPath = preparedFixture.path(
      'repo/.limina/tsconfig/checkers/tsc/solutions/packages/app/tsconfig.build.json',
    );
    const libraryProjectPath = preparedFixture.path(
      'repo/.limina/tsconfig/checkers/tsc/projects/packages/app/tsconfig.lib.dts.json',
    );
    const testProjectPath = preparedFixture.path(
      'repo/.limina/tsconfig/checkers/tsc/projects/packages/app/tsconfig.test.dts.json',
    );
    const checkerEntryPath = preparedFixture.path(
      'repo/.limina/tsconfig/checkers/tsc/tsconfig.build.json',
    );

    const prepareResult = await runFixtureLimina(preparedFixture, [
      'graph',
      'prepare',
    ]);
    expectLiminaSuccess(prepareResult);

    for (const generatedPath of [
      rootSolutionPath,
      packageSolutionPath,
      libraryProjectPath,
      testProjectPath,
      checkerEntryPath,
    ]) {
      expect(await isExists(generatedPath)).toBe(true);
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
    ).toEqual(new Set([libraryProjectPath, testProjectPath]));

    const manifest = await readJson<GeneratedManifest>(
      preparedFixture.path('repo/.limina/manifest.json'),
    );
    expect(manifest.version).toBe(5);
    expect(manifest.generatedBy).toBe('limina');
    expect(manifest.checkers.tsc.entry).toBe(
      '.limina/tsconfig/checkers/tsc/tsconfig.build.json',
    );
    expect(manifest.checkers.tsc.roots).toEqual([
      'packages/app/tsconfig.lib.json',
      'packages/app/tsconfig.test.json',
    ]);
    expect(manifest.checkers.tsc.sourceToBuild).toMatchObject({
      'packages/app/tsconfig.json': {
        kind: 'solution',
        path: '.limina/tsconfig/checkers/tsc/solutions/packages/app/tsconfig.build.json',
      },
      'packages/app/tsconfig.lib.json': {
        kind: 'project',
        path: '.limina/tsconfig/checkers/tsc/projects/packages/app/tsconfig.lib.dts.json',
      },
      'packages/app/tsconfig.test.json': {
        kind: 'project',
        path: '.limina/tsconfig/checkers/tsc/projects/packages/app/tsconfig.test.dts.json',
      },
      'tsconfig.json': {
        kind: 'solution',
        path: '.limina/tsconfig/checkers/tsc/solutions/tsconfig.build.json',
      },
    });
    expect(manifest.checkers.tsc.sourceToDts).toEqual({
      'packages/app/tsconfig.lib.json':
        '.limina/tsconfig/checkers/tsc/projects/packages/app/tsconfig.lib.dts.json',
      'packages/app/tsconfig.test.json':
        '.limina/tsconfig/checkers/tsc/projects/packages/app/tsconfig.test.dts.json',
    });

    const buildResult = await runFixtureLimina(preparedFixture, [
      'checker',
      'build',
    ]);
    expectLiminaSuccess(buildResult);

    const libraryDeclarationPath = preparedFixture.path(
      'repo/.limina/dts/checkers/tsc/packages/app/tsconfig.lib.json/index.d.ts',
    );
    const testDeclarationPath = preparedFixture.path(
      'repo/.limina/dts/checkers/tsc/packages/app/tsconfig.test.json/index.test.d.ts',
    );
    expect(await readFile(libraryDeclarationPath, 'utf8')).toContain(
      'export declare const libraryValue: "library";',
    );
    expect(await readFile(testDeclarationPath, 'utf8')).toContain(
      'export declare const testValue: "test";',
    );
    expect(
      await isExists(
        preparedFixture.path(
          'repo/.limina/tsbuildinfo/checkers/tsc/packages/app/tsconfig.lib.json.tsbuildinfo',
        ),
      ),
    ).toBe(true);
    expect(
      await isExists(
        preparedFixture.path(
          'repo/.limina/tsbuildinfo/checkers/tsc/packages/app/tsconfig.test.json.tsbuildinfo',
        ),
      ),
    ).toBe(true);
    expect(
      await collectPrivateEntries(preparedFixture.path('repo/packages/app')),
    ).toEqual([]);
  });
});
