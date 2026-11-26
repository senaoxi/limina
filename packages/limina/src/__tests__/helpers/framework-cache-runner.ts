import { resolveAstroSemanticToolchain } from '#checkers';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type ts from 'typescript';
import {
  AnalysisObserver,
  runWithProfile,
} from '../../application/analysis/observability';
import { loadConfig } from '../../config/loader';
import { frameworkExecutionInputs } from '../../core/analysis-cache/framework-execution-inputs';
import { LiminaPreflightManager } from '../../preflight';

const [checker, component, phase] = process.argv.slice(2);
const config = await loadConfig({
  configPath: path.resolve('limina.config.mjs'),
});
const observer = new AnalysisObserver('graph prepare', performance.now());
observer.setRoot(config.rootDir);
const counts = { graphBuilds: 0, restoredContexts: 0, programCreates: 0 };
const manager = new LiminaPreflightManager({
  config,
  analysisCache: true,
  metrics: {
    record(event) {
      if (
        event.name === 'analysis-cache' &&
        (event.kind === 'graphBuilds' || event.kind === 'restoredContexts')
      )
        counts[event.kind] += event.count ?? 0;
      if (event.name === 'bounded-program-create')
        counts.programCreates += event.count ?? 0;
    },
  },
});
try {
  const graph = await runWithProfile(observer, () =>
    manager.ensureGeneratedGraph(),
  );
  observer.stop(true);
  const { contexts, projects, work } = observer.snapshot();
  const executionInputPrograms = work.flatMap((item) => {
    if (
      item.op !== 'framework-execution-input-program-create' ||
      item.end !== 'performed'
    )
      return [];
    const context = contexts.find(({ id }) => id === item.scope[1]);
    return [
      {
        checker: context?.checker,
        configPath: projects.find(({ id }) => id === context?.project)?.path,
        provider: context?.provider,
        role: context?.role,
      },
    ];
  });
  await manager.publishAnalysisCache();
  const unit = graph.governedSources.get(checker!)!.values().next().value!;
  const astroProject = unit.astroSemanticProject;
  const astro = astroProject?.readSnapshot(
    resolveAstroSemanticToolchain(astroProject.seed.packageRootDir),
  );
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
      executionInputPrograms,
      configFile: configFile?.fileName,
      roots,
    }),
  );
} finally {
  manager.dispose();
}
