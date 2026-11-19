import type { ResolvedLiminaInputs } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import type { AnalysisMetricsRecorder } from '../../application/analysis/analysis-run';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import type { ImportAnalysisContext } from '../import-analysis/types';
import { createProjectDependencyCaches } from '../project-dependencies/runner';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import {
  type ValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../workspace/validated-context';
import type { CachedGraphData } from './analysis-cache-schema';
import { assertCollectedExecution } from './analysis-failure';
import { reconstructVueReferences } from './cached-vue-references';
import type { FrozenSemanticProject } from './locked-semantic-project';
import { inferProjectReferences } from './reference-inference';
import { createSourceProject } from './source-projects';
import type { GovernedSourceUnit, SourceProject } from './types';

interface Reconstruction {
  graph: CachedGraphData;
  config: ResolvedLiminaInputs;
  cache: NativeAnalysisCache;
  workspace: ValidatedWorkspaceContext;
  frozenProjectsByConfigPath: ReadonlyMap<string, FrozenSemanticProject>;
  importAnalysis: ImportAnalysisContext;
  metrics?: AnalysisMetricsRecorder;
}

function sourceProject(
  input: Reconstruction,
  source: GovernedSourceUnit,
): SourceProject {
  const project = createSourceProject({
    config: input.config,
    checkerName: source.primaryCheckerName,
    frozen: input.frozenProjectsByConfigPath.get(source.configPath)!,
    packageRootDir: source.packageRootDir,
  });
  return { ...project, context: source.context };
}

function requiresFrameworkReconstruction(source: GovernedSourceUnit): boolean {
  return (
    source.semanticAuthority.family === 'astro' ||
    source.semanticAuthority.family === 'svelte'
  );
}

export function reconstructCachedReferences(
  input: Reconstruction,
): ReadonlyMap<string, ReadonlySet<string>> {
  assertBoundFrameworkReferences(input);
  return reconstructVueReferences(input);
}

function assertBoundFrameworkReferences(input: Reconstruction): void {
  const { graph } = input;
  const frameworkCheckers = new Set(
    [...graph.governedSources]
      .filter(([, sources]) =>
        sources.values().some(requiresFrameworkReconstruction),
      )
      .map(([checker]) => checker),
  );
  if (
    graph.dependencyEdges.some(
      (edge) =>
        edge.kind === 'framework-schedule' &&
        !frameworkCheckers.has(edge.fromChecker),
    )
  )
    throw new Error('Cached scheduling dependency has no qualified consumer.');
  if (frameworkCheckers.size === 0) return;

  const sources = graph.governedSources
    .values()
    .flatMap((units) => units.values())
    .toArray();
  const primary = new Map(
    sources.map((source) => [source.configPath, sourceProject(input, source)]),
  );
  const declarations = new Map(
    sources
      .filter((source) => 'dtsConfigPath' in source.buildProjection)
      .map((source) => [source.configPath, primary.get(source.configPath)!]),
  );
  const activatedRegions = new WorkspaceRegionPathIndex(input.workspace);
  const caches = createProjectDependencyCaches(input.cache, input.metrics);
  caches.sourceConfigCoverage = graph.sourceConfigCoverage;
  for (const checker of frameworkCheckers) {
    const selected = graph.governedSources.get(checker)!.values().toArray();
    const projects = selected.flatMap((source) => {
      const project = declarations.get(source.configPath);
      return project === undefined ? [] : [project];
    });
    const result = inferProjectReferences({
      activatedRegions,
      config: input.config,
      governedSources: selected,
      ownerGovernedSources: sources,
      ownerProjects: declarations.values().toArray(),
      primaryProjects: selected.map(
        (source) => primary.get(source.configPath)!,
      ),
      projects,
      sourceToBuildByChecker: graph.sourceToBuild,
      projectDependencyCaches: caches,
      importAnalysisContext: input.importAnalysis,
      replayFrameworkExecutionInputs: true,
    });
    assertCollectedExecution(caches);
    assertReconstructedRelations(input, selected, result);
  }
}

function assertReconstructedRelations(
  input: Reconstruction,
  sources: readonly GovernedSourceUnit[],
  result: ReturnType<typeof inferProjectReferences>,
): void {
  const consumers = new Set(sources.map((source) => source.configPath));
  const expectedEdges = input.graph.dependencyEdges.filter((edge) =>
    consumers.has(edge.fromConfigPath),
  );
  const expectedDeclarations = (
    input.graph.dependencyAnalysis.declarationContexts ?? []
  ).filter((decision) => consumers.has(decision.consumerConfig));
  if (
    result.problems.length > 0 ||
    relationFingerprint(result.dependencyEdges) !==
      relationFingerprint(expectedEdges) ||
    relationFingerprint(result.analysis.declarationContexts ?? []) !==
      relationFingerprint(expectedDeclarations)
  )
    throw new Error(
      'Cached framework dependencies differ from current references.',
    );
}

function relationFingerprint(values: readonly unknown[]): string {
  return nativeFingerprint(
    values.map(nativeFingerprint).sort(compareCodeUnits),
  );
}
