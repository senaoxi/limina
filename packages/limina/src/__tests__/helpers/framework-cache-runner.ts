import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type ts from 'typescript';
import { loadConfig } from '../../config/loader';
import { frameworkExecutionInputs } from '../../core/analysis-cache/framework-execution-inputs';
import { LiminaPreflightManager } from '../../preflight';

const [checker, component, phase] = process.argv.slice(2);
const config = await loadConfig({
  configPath: path.resolve('limina.config.mjs'),
});
const counts = { graphHits: 0, programCreates: 0 };
const manager = new LiminaPreflightManager({
  config,
  analysisCache: true,
  metrics: {
    record(event) {
      if (event.name === 'analysis-cache' && event.kind === 'graphHits')
        counts.graphHits += event.count ?? 0;
      if (event.name === 'bounded-program-create')
        counts.programCreates += event.count ?? 0;
    },
  },
});
try {
  const graph = await manager.ensureGeneratedGraph();
  await manager.publishAnalysisCache();
  const unit = graph.governedSources.get(checker!)!.values().next().value!;
  const astro = unit.astroSemanticProject?.readSnapshot();
  const options = astro?.compilerOptions ?? unit.svelteSemanticProject?.options;
  const configFile = options?.configFile as ts.TsConfigSourceFile | undefined;
  const roots = astro?.fileNames ?? unit.svelteSemanticProject?.fileNames;
  const inputs = frameworkExecutionInputs(unit);
  await inputs.assertStable();
  if (phase === 'warm') {
    await writeFile(component!, '<p>changed</p>');
    await assert.rejects(inputs.assertStable(), {
      name: 'AnalysisInputDriftError',
      inputPath: component,
    });
  }
  console.log(
    JSON.stringify({
      ...counts,
      configFile: configFile?.fileName,
      roots,
    }),
  );
} finally {
  manager.dispose();
}
