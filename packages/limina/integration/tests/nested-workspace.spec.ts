import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toPortableRelativePath } from '../../src/__tests__/helpers/path';
import {
  expectLiminaSuccess,
  isExists,
  readJson,
  runFixtureLimina,
} from '../helpers/assertions';
import { type PreparedFixture, prepareFixture } from '../helpers/fixture';

interface DependencyGraphDocument {
  edges: {
    evidence: { importer: string; resolvedPath: string; specifier: string }[];
    from: string;
    kind: string;
    to: string;
  }[];
  nodes: { id: string; kind: string; name: string; path: string }[];
  rootDir: string;
  schemaVersion: number;
  view: string;
}

interface GeneratedManifest {
  checkers: {
    tsc: {
      roots: string[];
      sourceToBuild: Record<string, { kind: string; path: string }>;
      sourceToDts: Record<string, string>;
    };
  };
  ownedArtifacts: string[];
}

interface GeneratedProjectConfig {
  references: { path: string }[];
}

const fixtureState: { current: PreparedFixture | undefined } = {
  current: undefined,
};

async function collectChildTreePaths(options: {
  entryName: string;
  entryPath: string;
  entryStat: Awaited<ReturnType<typeof lstat>>;
}): Promise<string[]> {
  if (!options.entryStat.isDirectory()) return [];
  if (options.entryStat.isSymbolicLink()) return [];
  const childPaths = await collectTreePaths(options.entryPath);
  return childPaths.map((childPath) => `${options.entryName}/${childPath}`);
}

async function collectTreeEntryPaths(
  rootDirectory: string,
  entryName: string,
): Promise<string[]> {
  const entryPath = path.join(rootDirectory, entryName);
  const entryStat = await lstat(entryPath);
  return [
    toPortableRelativePath(rootDirectory, entryPath),
    ...(await collectChildTreePaths({ entryName, entryPath, entryStat })),
  ];
}

async function collectTreePaths(rootDirectory: string): Promise<string[]> {
  const entries = await readdir(rootDirectory);
  const paths = await Promise.all(
    entries.map((entryName) => collectTreeEntryPaths(rootDirectory, entryName)),
  );
  return paths
    .flat()
    .sort((left, right) => Number(left > right) - Number(left < right));
}

beforeEach(async () => {
  fixtureState.current = await prepareFixture('nested-workspace');
});

afterEach(async () => {
  await fixtureState.current?.cleanup();
  fixtureState.current = undefined;
});

describe('nested workspace public CLI integration', () => {
  it('keeps broad checker discovery inside the parent workspace boundary', async () => {
    const preparedFixture = fixtureState.current!;
    const exportResult = await runFixtureLimina(preparedFixture, [
      'graph',
      'export',
    ]);
    expectLiminaSuccess(exportResult);

    const graph = JSON.parse(exportResult.stdout) as DependencyGraphDocument;
    expect(graph.schemaVersion).toBe(1);
    expect(graph.view).toBe('all');
    expect(graph.nodes).toEqual([
      {
        id: 'pkg:@fixture/parent',
        kind: 'package',
        name: '@fixture/parent',
        path: 'packages/parent',
      },
    ]);
    expect(JSON.stringify(graph)).not.toContain('@fixture/nested');
    expect(JSON.stringify(graph)).not.toContain('packages/parent/nested');

    const prepareResult = await runFixtureLimina(preparedFixture, [
      'graph',
      'prepare',
    ]);
    expectLiminaSuccess(prepareResult);

    const parentProjectPath = preparedFixture.path(
      'repo/.limina/tsconfig/checkers/tsc/projects/packages/parent/tsconfig.dts.json',
    );
    const nestedProjectPath = preparedFixture.path(
      'repo/.limina/tsconfig/checkers/tsc/projects/packages/parent/nested/tsconfig.dts.json',
    );
    expect(await isExists(parentProjectPath)).toBe(true);
    expect(await isExists(nestedProjectPath)).toBe(false);

    const manifest = await readJson<GeneratedManifest>(
      preparedFixture.path('repo/.limina/manifest.json'),
    );
    expect(manifest.checkers.tsc.roots).toEqual([
      'packages/parent/tsconfig.json',
    ]);
    expect(manifest.checkers.tsc.sourceToBuild).toEqual({
      'packages/parent/tsconfig.json': {
        kind: 'project',
        path: '.limina/tsconfig/checkers/tsc/projects/packages/parent/tsconfig.dts.json',
      },
    });
    expect(manifest.checkers.tsc.sourceToDts).toEqual({
      'packages/parent/tsconfig.json':
        '.limina/tsconfig/checkers/tsc/projects/packages/parent/tsconfig.dts.json',
    });
    expect(JSON.stringify(manifest)).not.toContain(
      'packages/parent/nested/tsconfig.json',
    );

    const parentProject =
      await readJson<GeneratedProjectConfig>(parentProjectPath);
    expect(JSON.stringify(parentProject)).not.toContain('nested');
    expect(parentProject.references).toEqual([]);

    const generatedPaths = await collectTreePaths(
      preparedFixture.path('repo/.limina'),
    );
    expect(
      generatedPaths.some((entryPath) => entryPath.includes('nested')),
    ).toBe(false);
    expect(
      manifest.ownedArtifacts.some((entryPath) => entryPath.includes('nested')),
    ).toBe(false);
  });
});
