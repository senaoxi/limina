import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

interface DeclarationMap {
  file: string;
  sources: string[];
  version: number;
}

interface GeneratedOutputConfig {
  compilerOptions: {
    declaration: boolean;
    declarationMap: boolean;
    noEmit: boolean;
    outDir: string;
    rootDir: string;
    target: string;
    tsBuildInfoFile: string;
  };
  extends: string[];
  files: string[];
  include: unknown[];
}

const checkedInSourcePath = fileURLToPath(
  new URL(
    '../../fixtures/managed-outputs/repo/packages/library/src/index.ts',
    import.meta.url,
  ),
);

let fixture: PreparedFixture | undefined;

async function collectNamedEntries(
  rootDir: string,
  predicate: (entryName: string) => boolean,
): Promise<string[]> {
  const matches: string[] = [];

  for (const entryName of await readdir(rootDir)) {
    const entryPath = path.join(rootDir, entryName);
    const entryStat = await lstat(entryPath);

    if (predicate(entryName)) {
      matches.push(toPortablePath(entryPath));
      continue;
    }

    if (entryStat.isDirectory() && !entryStat.isSymbolicLink()) {
      matches.push(...(await collectNamedEntries(entryPath, predicate)));
    }
  }

  return matches.sort();
}

function expectValidDeclarationMap(map: DeclarationMap): void {
  expect(map.version).toBe(3);
  expect(map.file).toBe('index.d.ts');
  expect(map.sources).toHaveLength(1);
  expect(map.sources[0]).toMatch(/src\/index\.ts$/u);
}

beforeEach(async () => {
  fixture = await prepareFixture('managed-outputs');
});

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

describe('managed outputs public CLI integration', () => {
  it('builds and rebuilds the user artifact lifecycle', async () => {
    const preparedFixture = fixture!;
    const sourceConfigPath = preparedFixture.path(
      'repo/packages/library/tsconfig.json',
    );
    const runtimeSourcePath = preparedFixture.path(
      'repo/packages/library/src/index.ts',
    );
    const environmentSourcePath = preparedFixture.path(
      'repo/packages/library/src/environment.d.ts',
    );
    const outputConfigPath = preparedFixture.path(
      'repo/.limina/tsconfig/checkers/typescript/outputs/projects/packages/library/tsconfig.output.json',
    );
    const outputRoot = preparedFixture.path('repo/packages/library/dist');
    const jsPath = preparedFixture.path('repo/packages/library/dist/index.js');
    const declarationPath = preparedFixture.path(
      'repo/packages/library/dist/index.d.ts',
    );
    const declarationMapPath = preparedFixture.path(
      'repo/packages/library/dist/index.d.ts.map',
    );
    const environmentOutputPath = preparedFixture.path(
      'repo/packages/library/dist/environment.d.ts',
    );
    const tsBuildInfoPath = preparedFixture.path(
      'repo/.limina/tsbuildinfo/build/packages/library/tsconfig.tsbuildinfo',
    );
    const checkedInSource = await readFile(checkedInSourcePath, 'utf8');
    const environmentSource = await readFile(environmentSourcePath, 'utf8');

    const firstBuild = await runFixtureLimina(preparedFixture, [
      'build',
      'packages/library/tsconfig.json',
    ]);
    expectLiminaSuccess(firstBuild);

    for (const generatedPath of [
      outputConfigPath,
      jsPath,
      declarationPath,
      declarationMapPath,
      environmentOutputPath,
      tsBuildInfoPath,
    ]) {
      expect(await exists(generatedPath)).toBe(true);
    }

    const firstOutputConfigText = await readFile(outputConfigPath, 'utf8');
    const outputConfig = JSON.parse(
      firstOutputConfigText,
    ) as GeneratedOutputConfig;
    expect(outputConfig.extends).toHaveLength(1);
    expect(
      resolveGeneratedPath(outputConfigPath, outputConfig.extends[0]!),
    ).toBe(sourceConfigPath);
    expect(
      new Set(
        outputConfig.files.map((filePath) =>
          resolveGeneratedPath(outputConfigPath, filePath),
        ),
      ),
    ).toEqual(new Set([runtimeSourcePath, environmentSourcePath]));
    expect(outputConfig.include).toEqual([]);
    expect(outputConfig.compilerOptions).toMatchObject({
      declaration: true,
      declarationMap: true,
      noEmit: false,
      target: 'ES2023',
    });
    expect(
      resolveGeneratedPath(
        outputConfigPath,
        outputConfig.compilerOptions.rootDir,
      ),
    ).toBe(preparedFixture.path('repo/packages/library/src'));
    expect(
      resolveGeneratedPath(
        outputConfigPath,
        outputConfig.compilerOptions.outDir,
      ),
    ).toBe(outputRoot);
    expect(
      resolveGeneratedPath(
        outputConfigPath,
        outputConfig.compilerOptions.tsBuildInfoFile,
      ),
    ).toBe(tsBuildInfoPath);

    const firstJs = await readFile(jsPath, 'utf8');
    const firstDeclaration = await readFile(declarationPath, 'utf8');
    expect(firstJs).toMatch(/managedValue = ['"]initial['"]/u);
    expect(firstDeclaration).toContain(
      'export declare const managedValue: "initial";',
    );
    expectValidDeclarationMap(
      await readJson<DeclarationMap>(declarationMapPath),
    );
    expect(await readFile(environmentOutputPath, 'utf8')).toBe(
      environmentSource,
    );

    await writeFile(
      runtimeSourcePath,
      "export const managedValue = 'updated' as const;\n",
    );

    const rebuild = await runFixtureLimina(preparedFixture, [
      'build',
      'packages/library/tsconfig.json',
    ]);
    expectLiminaSuccess(rebuild);

    const rebuiltJs = await readFile(jsPath, 'utf8');
    const rebuiltDeclaration = await readFile(declarationPath, 'utf8');
    expect(rebuiltJs).not.toBe(firstJs);
    expect(rebuiltJs).toMatch(/managedValue = ['"]updated['"]/u);
    expect(rebuiltDeclaration).not.toBe(firstDeclaration);
    expect(rebuiltDeclaration).toContain(
      'export declare const managedValue: "updated";',
    );
    expectValidDeclarationMap(
      await readJson<DeclarationMap>(declarationMapPath),
    );
    expect(await readFile(environmentOutputPath, 'utf8')).toBe(
      environmentSource,
    );
    expect(await readFile(outputConfigPath, 'utf8')).toBe(
      firstOutputConfigText,
    );
    expect(await exists(tsBuildInfoPath)).toBe(true);
    expect(
      await collectNamedEntries(
        preparedFixture.path(
          'repo/.limina/tsconfig/checkers/typescript/outputs/projects',
        ),
        (entryName) => entryName.endsWith('.output.json'),
      ),
    ).toEqual([outputConfigPath]);
    expect(
      await collectNamedEntries(
        preparedFixture.path('repo/.limina/tsbuildinfo/build'),
        (entryName) => entryName.endsWith('.tsbuildinfo'),
      ),
    ).toEqual([tsBuildInfoPath]);
    expect(
      await collectNamedEntries(
        preparedFixture.path('repo/packages/library'),
        (entryName) =>
          entryName === '.limina' || entryName.endsWith('.tsbuildinfo'),
      ),
    ).toEqual([]);
    expect(await readFile(checkedInSourcePath, 'utf8')).toBe(checkedInSource);
  });
});
