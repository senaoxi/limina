import { loadConfig } from '#config/runner';
import { prepareGeneratedTsconfigGraph } from '#core/build-graph/runner';
import { afterAll, bench, describe } from 'vitest';
import { collectDependencyGraph } from '../src/dependency-graph/runner';
import { createLiminaArtifactNamespace } from '../src/domain/artifacts/namespace';
import { createBenchWorkspace } from './fixture';

// Each package builds bounded TypeScript programs; under CPU simulation every
// benchmark body also runs several warmup rounds, so keep the workspace small.
const shape = { packages: 3, fanIn: 2, modulesPerPackage: 3 };

const workspace = await createBenchWorkspace(shape);
const config = await loadConfig({
  configPath: workspace.configPath,
  cwd: workspace.rootDir,
});

afterAll(async () => {
  await workspace.dispose();
});

describe('graph', () => {
  bench('prepare generated tsconfig graph', async () => {
    const graph = await prepareGeneratedTsconfigGraph(config, {
      artifactNamespace: createLiminaArtifactNamespace({
        generation: 0,
        rootDir: config.rootDir,
      }),
    });
    if (graph.manifest.dependencyEdges.length === 0)
      throw new Error('Expected generated graph dependency edges.');
  });

  bench('collect dependency graph', async () => {
    const graph = await collectDependencyGraph(config);
    if (graph.edges.length === 0)
      throw new Error('Expected dependency graph edges.');
  });
});
