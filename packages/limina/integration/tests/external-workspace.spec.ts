import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  toPortablePath,
  toPortableRelativePath,
} from '../../src/__tests__/helpers/path';
import { type PreparedFixture, prepareFixture } from '../helpers/fixture';
import { runLimina, type RunLiminaResult } from '../helpers/run-limina';

interface DependencyGraphNode {
  id: string;
  kind: string;
  name: string;
  path: string;
}

interface DependencyGraphEvidence {
  importer: string;
  resolvedPath: string;
  specifier: string;
}

interface DependencyGraphEdge {
  evidence: DependencyGraphEvidence[];
  from: string;
  kind: string;
  to: string;
}

interface DependencyGraphDocument {
  edges: DependencyGraphEdge[];
  nodes: DependencyGraphNode[];
}

interface GeneratedDtsConfig {
  compilerOptions: {
    outDir: string;
    tsBuildInfoFile: string;
  };
  extends: string[];
  files: string[];
  references: { path: string }[];
}

interface ExternalProjectPaths {
  generatedConfigPath: string;
  hash: string;
}

let fixture: PreparedFixture | undefined;

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return false;
    }

    throw error;
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

function resolveGeneratedPath(configPath: string, value: string): string {
  return toPortablePath(path.resolve(path.dirname(configPath), value));
}

function formatResult(result: RunLiminaResult): string {
  return [
    `fixture: ${result.fixtureName}`,
    `exit code: ${String(result.code)}`,
    `signal: ${String(result.signal)}`,
    `timed out: ${String(result.timedOut)}`,
    `stdout:\n${result.stdout}`,
    `stderr:\n${result.stderr}`,
  ].join('\n');
}

function expectLiminaSuccess(result: RunLiminaResult): void {
  const diagnostic = formatResult(result);

  expect(result.timedOut, diagnostic).toBe(false);
  expect(result.signal, diagnostic).toBeNull();
  expect(result.code, diagnostic).toBe(0);
}

async function runFixtureLimina(
  preparedFixture: PreparedFixture,
  args: string[],
): Promise<RunLiminaResult> {
  return runLimina({
    args: ['--config', preparedFixture.configPath, ...args],
    cwd: preparedFixture.cwd,
    fixtureName: preparedFixture.fixtureName,
    timeout: 90_000,
  });
}

async function getExternalHashes(
  preparedFixture: PreparedFixture,
): Promise<string[]> {
  const entries = await readdir(
    preparedFixture.path(
      'repo/.limina/tsconfig/checkers/typescript/projects/external',
    ),
    { withFileTypes: true },
  );

  return entries
    .filter(
      (entry) => entry.isDirectory() && /^[a-f0-9]{64}$/u.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
}

async function discoverExternalProject(
  preparedFixture: PreparedFixture,
): Promise<ExternalProjectPaths> {
  const hashes = await getExternalHashes(preparedFixture);
  expect(hashes).toHaveLength(1);
  const hash = hashes[0]!;

  return {
    generatedConfigPath: preparedFixture.path(
      'repo/.limina/tsconfig/checkers/typescript/projects/external',
      hash,
      'tsconfig.dts.json',
    ),
    hash,
  };
}

function expectInside(rootDir: string, candidatePath: string): void {
  const relativePath = toPortableRelativePath(rootDir, candidatePath);

  expect(relativePath).not.toBe('..');
  expect(relativePath.startsWith('../')).toBe(false);
}

beforeEach(async () => {
  fixture = await prepareFixture('external-workspace');
});

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

describe('external workspace public CLI integration', () => {
  it('exports the discovered internal and external source edge', async () => {
    const preparedFixture = fixture!;
    const result = await runFixtureLimina(preparedFixture, ['graph', 'export']);
    expectLiminaSuccess(result);

    const graph = JSON.parse(result.stdout) as DependencyGraphDocument;
    const appNode = graph.nodes.find((node) => node.name === '@fixture/app');
    const sharedNode = graph.nodes.find(
      (node) => node.name === '@fixture/shared',
    );

    expect(appNode).toMatchObject({
      id: 'pkg:@fixture/app',
      kind: 'package',
      path: 'packages/app',
    });
    expect(sharedNode).toMatchObject({
      id: 'pkg:@fixture/shared',
      kind: 'package',
      path: '../external/shared',
    });

    const sourceEdges = graph.edges.filter(
      (edge) =>
        edge.from === 'pkg:@fixture/app' &&
        edge.kind === 'source' &&
        edge.to === 'pkg:@fixture/shared',
    );

    expect(sourceEdges).toHaveLength(1);
    expect(sourceEdges[0]?.evidence).toEqual(
      expect.arrayContaining([
        {
          importer: 'packages/app/src/index.ts',
          resolvedPath: '../external/shared/src/index.ts',
          specifier: '@fixture/shared',
        },
      ]),
    );
  });

  it('materializes internal and external generated projects', async () => {
    const preparedFixture = fixture!;
    const result = await runFixtureLimina(preparedFixture, [
      'graph',
      'prepare',
    ]);
    expectLiminaSuccess(result);

    const manifestPath = preparedFixture.path('repo/.limina/manifest.json');
    const internalConfigPath = preparedFixture.path(
      'repo/.limina/tsconfig/checkers/typescript/projects/packages/app/tsconfig.dts.json',
    );
    const externalProject = await discoverExternalProject(preparedFixture);

    expect(await exists(manifestPath)).toBe(true);
    expect(await exists(internalConfigPath)).toBe(true);
    expect(await exists(externalProject.generatedConfigPath)).toBe(true);
    expect(externalProject.generatedConfigPath).not.toBe(internalConfigPath);

    const externalConfig = await readJson<GeneratedDtsConfig>(
      externalProject.generatedConfigPath,
    );
    expect(externalConfig.extends).toHaveLength(1);
    expect(
      resolveGeneratedPath(
        externalProject.generatedConfigPath,
        externalConfig.extends[0]!,
      ),
    ).toBe(preparedFixture.path('external/shared/tsconfig.json'));
    expect(
      new Set(
        externalConfig.files.map((filePath) =>
          resolveGeneratedPath(externalProject.generatedConfigPath, filePath),
        ),
      ),
    ).toEqual(new Set([preparedFixture.path('external/shared/src/index.ts')]));

    const externalOutDir = resolveGeneratedPath(
      externalProject.generatedConfigPath,
      externalConfig.compilerOptions.outDir,
    );
    const externalTsBuildInfoPath = resolveGeneratedPath(
      externalProject.generatedConfigPath,
      externalConfig.compilerOptions.tsBuildInfoFile,
    );
    expectInside(preparedFixture.path('repo/.limina/dts'), externalOutDir);
    expectInside(
      preparedFixture.path('repo/.limina/tsbuildinfo'),
      externalTsBuildInfoPath,
    );

    const internalConfig =
      await readJson<GeneratedDtsConfig>(internalConfigPath);
    const internalReferences = internalConfig.references.map((reference) =>
      resolveGeneratedPath(internalConfigPath, reference.path),
    );
    expect(internalReferences).toHaveLength(1);
    expect(internalReferences).toContain(externalProject.generatedConfigPath);
  });
});
