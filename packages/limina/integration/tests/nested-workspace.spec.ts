import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toPortableRelativePath } from '../../src/__tests__/helpers/path';
import {
  exists,
  expectLiminaSuccess,
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
    typescript: {
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

let fixture: PreparedFixture | undefined;

async function collectTreePaths(rootDir: string): Promise<string[]> {
  const paths: string[] = [];

  for (const entryName of await readdir(rootDir)) {
    const entryPath = path.join(rootDir, entryName);
    const entryStat = await lstat(entryPath);
    paths.push(toPortableRelativePath(rootDir, entryPath));

    if (entryStat.isDirectory() && !entryStat.isSymbolicLink()) {
      for (const childPath of await collectTreePaths(entryPath)) {
        paths.push(`${entryName}/${childPath}`);
      }
    }
  }

  return paths.sort();
}

beforeEach(async () => {
  fixture = await prepareFixture('nested-workspace');
});

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

describe('nested workspace public CLI integration', () => {
  it('keeps broad checker discovery inside the parent workspace boundary', async () => {
    const preparedFixture = fixture!;
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
      'repo/.limina/tsconfig/checkers/typescript/projects/packages/parent/tsconfig.dts.json',
    );
    const nestedProjectPath = preparedFixture.path(
      'repo/.limina/tsconfig/checkers/typescript/projects/packages/parent/nested/tsconfig.dts.json',
    );
    expect(await exists(parentProjectPath)).toBe(true);
    expect(await exists(nestedProjectPath)).toBe(false);

    const manifest = await readJson<GeneratedManifest>(
      preparedFixture.path('repo/.limina/manifest.json'),
    );
    expect(manifest.checkers.typescript.roots).toEqual([
      'packages/parent/tsconfig.json',
    ]);
    expect(manifest.checkers.typescript.sourceToBuild).toEqual({
      'packages/parent/tsconfig.json': {
        kind: 'project',
        path: '.limina/tsconfig/checkers/typescript/projects/packages/parent/tsconfig.dts.json',
      },
    });
    expect(manifest.checkers.typescript.sourceToDts).toEqual({
      'packages/parent/tsconfig.json':
        '.limina/tsconfig/checkers/typescript/projects/packages/parent/tsconfig.dts.json',
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
