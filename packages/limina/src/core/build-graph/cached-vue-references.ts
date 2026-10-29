import type { ResolvedLiminaInputs } from '#config/runner';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import {
  createProjectDependencyCaches,
  withProjectDependencyReplay,
} from '../project-dependencies/runner';
import { VueSemanticContextManager } from '../vue-semantic/context';
import {
  type ValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../workspace/validated-context';
import type { CachedGraphData } from './analysis-cache-schema';
import { resolveBuildGraphImportAnalysis } from './import-analysis-context';
import { inferProjectReferences } from './reference-inference';
import { createSourceProject } from './source-projects';
import type { GovernedSourceUnit, SourceProject } from './types';

interface Reconstruction {
  graph: CachedGraphData;
  config: ResolvedLiminaInputs;
  cache: NativeAnalysisCache;
  workspace: ValidatedWorkspaceContext;
}

function sourceProject(
  input: Reconstruction,
  source: GovernedSourceUnit,
): SourceProject {
  const project = createSourceProject({
    config: input.config,
    checkerName: source.primaryCheckerName,
    checkerPreset: source.context.checkerPresets[0]!,
    discoveryExtensions: source.context.extensions,
    packageRootDir: source.packageRootDir,
    sourceConfigPath: source.configPath,
    semanticAuthority: source.semanticAuthority,
  });
  // Current configuration owns roots; the qualified context owns identity.
  // Cached membership, edges and admission cannot supply reference authority.
  return { ...project, context: source.context };
}

/**
Reuse the producer's projection over qualified Vue queries, including closure.
*/
export function reconstructVueReferences(
  input: Reconstruction,
): ReadonlyMap<string, ReadonlySet<string>> {
  const sources = input.graph.governedSources
    .values()
    .flatMap((units) => units.values())
    .filter((source) => 'dtsConfigPath' in source.buildProjection)
    .toArray();
  const vueSources = sources.filter(
    (source) => source.semanticAuthority.family === 'vue',
  );
  if (vueSources.length === 0) return new Map();
  const primary = sources.map((source) => sourceProject(input, source));
  const projects = primary.filter(
    (project) => project.semanticAuthority.family === 'vue',
  );
  return collectReferences(input, {
    sources,
    vueSources,
    primary,
    projects,
  });
}

function collectReferences(
  input: Reconstruction,
  selected: {
    sources: GovernedSourceUnit[];
    vueSources: GovernedSourceUnit[];
    primary: SourceProject[];
    projects: SourceProject[];
  },
): ReadonlyMap<string, ReadonlySet<string>> {
  const contexts = new VueSemanticContextManager(undefined, input.cache);
  const caches = createProjectDependencyCaches(input.cache);
  caches.sourceConfigCoverage = input.graph.sourceConfigCoverage;
  try {
    const result = withProjectDependencyReplay(caches, () =>
      inferProjectReferences({
        config: input.config,
        activatedRegions: new WorkspaceRegionPathIndex(input.workspace),
        governedSources: selected.vueSources,
        ownerGovernedSources: selected.sources,
        ownerProjects: selected.primary,
        projects: selected.projects,
        primaryProjects: selected.primary,
        sourceToBuildByChecker: input.graph.sourceToBuild,
        projectDependencyCaches: caches,
        importAnalysisContext: resolveBuildGraphImportAnalysis({
          config: input.config,
          vueSemanticContexts: contexts,
        }),
      }),
    );
    if (result.problems.length > 0)
      throw new Error('Vue reference reconstruction is incomplete.');
    return new Map(
      selected.projects.map((project) => [
        project.configPath,
        project.references,
      ]),
    );
  } finally {
    contexts.dispose();
  }
}
