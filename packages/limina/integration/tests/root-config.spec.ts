import { loadConfig } from '#config/runner';
import { createAnalysisProviders } from '#core';
import { normalizeAbsolutePath } from '#utils/path';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createFixturePathResolver } from '../../src/__tests__/helpers/path';

it('points the repository lib pipeline at its generated tsgo checker entry', async () => {
  const rootDir = fileURLToPath(new URL('../../../../', import.meta.url));
  const config = await loadConfig({
    configLoader: 'tsx',
    configPath: path.join(rootDir, 'limina.config.mts'),
    cwd: rootDir,
  });
  const fixtureRoot = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-root-config-')),
  );
  const fixturePath = createFixturePathResolver(fixtureRoot);
  let providers: ReturnType<typeof createAnalysisProviders> | undefined;

  try {
    // Keep the real repository configuration, but bound graph analysis to a
    // small workspace. The full repository graph is covered by `limina check`.
    await mkdir(fixturePath('packages/lib/src'), { recursive: true });
    await writeFile(fixturePath('package.json'), '{"private":true}');
    await writeFile(
      fixturePath('pnpm-workspace.yaml'),
      'packages:\n  - packages/*\n',
    );
    await writeFile(
      fixturePath('packages/lib/package.json'),
      '{"name":"@fixture/lib","private":true,"type":"module"}',
    );
    await writeFile(
      fixturePath('packages/lib/src/tsconfig.json'),
      JSON.stringify({
        compilerOptions: { composite: true, types: [] },
        files: ['index.ts'],
      }),
    );
    await writeFile(
      fixturePath('packages/lib/src/index.ts'),
      'export const value = 1;\n',
    );
    providers = createAnalysisProviders({
      ...config,
      rootDir: fixturePath(),
    });
    const graph = await providers.buildGraph.getGraph();
    const checkerEntry = graph.checkerEntries.get('tsgo');
    if (checkerEntry === undefined)
      throw new Error('Missing tsgo checker entry.');
    // Inspect this repository's command contract, not arbitrary pipeline args.
    const pipeline = config.pipelines?.lib;
    expect(pipeline).toHaveLength(2);
    expect(pipeline?.[0]).toBe('graph:prepare');
    const command = pipeline?.[1];
    if (typeof command !== 'object' || command.type !== 'command') {
      throw new Error('The repository lib pipeline must invoke tsgo.');
    }
    expect(command.command).toBe('tsgo');
    expect(command.args?.[0]).toBe('-b');
    expect(
      normalizeAbsolutePath(path.resolve(fixtureRoot, command.args![1]!)),
    ).toBe(checkerEntry);
    expect(graph.generatedFiles.has(checkerEntry)).toBe(true);
    expect(
      JSON.parse(graph.generatedFiles.get(checkerEntry)!).references,
    ).not.toHaveLength(0);
  } finally {
    providers?.dispose();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
