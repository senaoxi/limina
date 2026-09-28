import { isCheckerCacheReusable } from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import { toRelativePath } from '#utils/path';
import { createGeneratedGraphStructuredError } from './problems';
import type {
  CheckerSourceConfigCollection,
  GeneratedBuildModule,
  PreparedCheckerGraph,
  ResolvedCheckerEntrySelection,
} from './types';

type BuildCheckerName = ResolvedCheckerEntrySelection['checker']['name'];
type CrossCheckerReference =
  CheckerSourceConfigCollection['crossCheckerReferences'][number];

function addExplicitOwner(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  owner: BuildCheckerName;
  owners: Map<string, BuildCheckerName>;
  problems: string[];
}): void {
  const current = options.owners.get(options.configPath);
  if (current === undefined) {
    options.owners.set(options.configPath, options.owner);
    return;
  }
  if (current === options.owner) return;
  options.problems.push(
    [
      'Ambiguous explicit checker ownership:',
      `  config: ${toRelativePath(options.config.rootDir, options.configPath)}`,
      `  checkers: ${current}, ${options.owner}`,
      '  fix: adjust checker include/exclude rules so exactly one build checker directly owns this config.',
    ].join('\n'),
  );
}

function assertNoOwnershipProblems(options: {
  config: ResolvedLiminaConfig;
  fallback: string;
  problems: string[];
}): void {
  if (options.problems.length === 0) return;
  throw createGeneratedGraphStructuredError(options);
}

export function createExplicitOwnerMap(options: {
  config: ResolvedLiminaConfig;
  selections: ResolvedCheckerEntrySelection[];
}): Map<string, BuildCheckerName> {
  const owners = new Map<string, BuildCheckerName>();
  const problems: string[] = [];
  for (const selection of options.selections) {
    for (const configPath of selection.selection.effectiveEntryPaths) {
      addExplicitOwner({
        config: options.config,
        configPath,
        owner: selection.checker.name,
        owners,
        problems,
      });
    }
  }
  assertNoOwnershipProblems({
    config: options.config,
    fallback: 'Failed to assign explicit checker ownership.',
    problems,
  });
  return owners;
}

function getTargetModule(options: {
  graphByChecker: ReadonlyMap<string, PreparedCheckerGraph>;
  reference: CrossCheckerReference;
}): GeneratedBuildModule | null {
  const targetGraph = options.graphByChecker.get(options.reference.toChecker);
  if (targetGraph === undefined) return null;
  return (
    targetGraph.collection.buildModulesBySourcePath.get(
      options.reference.toConfigPath,
    ) ?? null
  );
}

function getCacheReuse(
  consumer: BuildCheckerName,
  provider: BuildCheckerName,
): 'non-reusable' | 'reusable' {
  return isCheckerCacheReusable({ consumer, provider })
    ? 'reusable'
    : 'non-reusable';
}

function addMissingReferenceProblem(options: {
  config: ResolvedLiminaConfig;
  problems: string[];
  reference: CrossCheckerReference;
}): void {
  options.problems.push(
    [
      'Unable to connect cross-checker project reference:',
      `  from: ${toRelativePath(options.config.rootDir, options.reference.fromConfigPath)}`,
      `  to: ${toRelativePath(options.config.rootDir, options.reference.toConfigPath)}`,
      `  provider checker: ${options.reference.toChecker}`,
    ].join('\n'),
  );
}

function connectCrossCheckerReference(options: {
  config: ResolvedLiminaConfig;
  graph: PreparedCheckerGraph;
  graphByChecker: ReadonlyMap<string, PreparedCheckerGraph>;
  problems: string[];
  reference: CrossCheckerReference;
}): void {
  const targetModule = getTargetModule(options);
  if (targetModule === null) {
    addMissingReferenceProblem(options);
    return;
  }
  const consumerSolution = options.graph.solutions.find(
    (solution) => solution.configPath === options.reference.fromConfigPath,
  );
  if (consumerSolution === undefined) {
    addMissingReferenceProblem(options);
    return;
  }
  consumerSolution.references.add(targetModule.path);
  options.graph.dependencyEdges.push({
    cacheReuse: getCacheReuse(
      options.graph.checker.name,
      options.reference.toChecker,
    ),
    file: toRelativePath(
      options.config.rootDir,
      options.reference.fromConfigPath,
    ),
    fromChecker: options.graph.checker.name,
    fromConfigPath: options.reference.fromConfigPath,
    importedSpecifier: 'project-reference',
    kind: 'declaration-provider',
    resolvedFilePath: options.reference.toConfigPath,
    toChecker: options.reference.toChecker,
    toConfigPath: options.reference.toConfigPath,
  });
}

export function connectCrossCheckerReferences(options: {
  config: ResolvedLiminaConfig;
  graphs: PreparedCheckerGraph[];
}): void {
  const graphByChecker = new Map(
    options.graphs.map((graph) => [graph.checker.name, graph]),
  );
  const problems: string[] = [];
  for (const graph of options.graphs) {
    for (const reference of graph.collection.crossCheckerReferences) {
      connectCrossCheckerReference({
        config: options.config,
        graph,
        graphByChecker,
        problems,
        reference,
      });
    }
  }
  assertNoOwnershipProblems({
    config: options.config,
    fallback: 'Failed to connect cross-checker project references.',
    problems,
  });
}
