import { loadConfig } from '#config/runner';
import { createAnalysisProviders } from '#core';
import { normalizeAbsolutePath } from '#utils/path';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('points the repository lib pipeline at its generated tsgo checker entry', async () => {
  const rootDir = fileURLToPath(new URL('../../../../', import.meta.url));
  const config = await loadConfig({
    configLoader: 'tsx',
    configPath: path.join(rootDir, 'limina.config.mts'),
    cwd: rootDir,
  });
  const providers = createAnalysisProviders(config);

  try {
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
      normalizeAbsolutePath(path.resolve(rootDir, command.args![1]!)),
    ).toBe(checkerEntry);
    expect(graph.generatedFiles.has(checkerEntry)).toBe(true);
    expect(
      JSON.parse(graph.generatedFiles.get(checkerEntry)!).references,
    ).not.toHaveLength(0);
  } finally {
    providers.dispose();
  }
});
