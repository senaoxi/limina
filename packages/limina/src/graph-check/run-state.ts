import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import {
  createFileOwnerLookup,
  type ProjectInfo,
} from '#core/import-graph/context';
import type { WorkspacePackage } from '#core/workspace/actions';
import {
  type CheckCounter,
  createCheckCounter,
  createCheckItemAccumulator,
} from '../check-reporting/stats';
import {
  createManagedOutputDeclarationLookup,
  type ManagedOutputDeclarationLookup,
} from '../core/import-graph/managed-output-provider';
import {
  createWorkspaceExportsResolutionIndex,
  type WorkspaceExportsResolutionIndex,
} from '../core/workspace/exports';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import { type LiminaPreflightManager, resolvePreflight } from '../preflight';
import {
  createGeneratedGraphPathAliases,
  createGraphCheckManagedOutputProjectContexts,
  createWorkspaceExportsResolutionProfiles,
  filterProjectInfoToActivatedRegion,
} from './check-context';
import type { GraphFinding } from './findings';
import { createGeneratedProjectCheckerNamesByPath } from './generated-project-paths';
import { type NormalizedGraphRules, normalizeGraphRules } from './rules';
import {
  GRAPH_CHECK_ITEM_NAMES,
  type RunGraphCheckImplOptions,
} from './runner-types';

export interface GraphCheckState {
  checks: CheckCounter;
  checkItems: ReturnType<typeof createCheckItemAccumulator>;
  config: ResolvedLiminaConfig;
  fileOwnerLookup: Map<string, string[]>;
  findings: GraphFinding[];
  generatedGraph: GeneratedTsconfigGraphResult;
  graphRoute: Awaited<
    ReturnType<LiminaPreflightManager['ensureSourceGraphProjectExtensions']>
  >;
  graphRules: NormalizedGraphRules;
  managedOutputLookup: ManagedOutputDeclarationLookup;
  options: RunGraphCheckImplOptions;
  packages: WorkspacePackage[];
  preflight: LiminaPreflightManager;
  projectCheckerNamesByPath: Map<string, string>;
  projectPaths: string[];
  projects: ProjectInfo[];
  projectsByPath: Map<string, ProjectInfo>;
  workspaceExports: WorkspaceExportsResolutionIndex;
  workspaceLookup: WorkspaceLookupIndex;
}

async function collectProjects(options: {
  preflight: LiminaPreflightManager;
  projectPaths: string[];
  graphRoute: GraphCheckState['graphRoute'];
  workspaceLookup: WorkspaceLookupIndex;
}): Promise<ProjectInfo[]> {
  const projects = await Promise.all(
    options.projectPaths.map((projectPath) =>
      options.preflight.providers.tsconfig.getProject(
        projectPath,
        options.graphRoute.projectContextsByPath.get(projectPath),
      ),
    ),
  );

  return projects.map((project) =>
    filterProjectInfoToActivatedRegion(project, options.workspaceLookup),
  );
}

export async function createGraphCheckState(
  config: ResolvedLiminaConfig,
  options: RunGraphCheckImplOptions,
): Promise<GraphCheckState> {
  const findings: GraphFinding[] = [];
  const checks = createCheckCounter();
  const checkItems = createCheckItemAccumulator(
    () => findings.length,
    () => checks.value,
    { plannedItems: GRAPH_CHECK_ITEM_NAMES, progress: options.progress },
  );
  const preflight = resolvePreflight(config, options);
  const generatedGraph = await preflight.ensureGeneratedGraph();
  const graphRoute = await preflight.ensureSourceGraphProjectExtensions();
  const projectPaths = [...graphRoute.projectExtensionsByPath.keys()].sort();
  const workspaceLookup = await preflight.ensureWorkspaceLookupIndex();
  const projects = await collectProjects({
    graphRoute,
    preflight,
    projectPaths,
    workspaceLookup,
  });
  const projectsByPath = new Map(
    projects.map((project) => [project.configPath, project]),
  );
  const projectCheckerNamesByPath =
    createGeneratedProjectCheckerNamesByPath(generatedGraph);
  const packages = await preflight.ensureWorkspacePackages();
  const workspaceExports = await createWorkspaceExportsResolutionIndex({
    config,
    importAnalysis: preflight.importAnalysis,
    metrics: preflight.profilingMetrics,
    packages,
    profiles: createWorkspaceExportsResolutionProfiles(projects),
  });
  const graphRules = normalizeGraphRules({
    config,
    include: { deps: true, refs: true },
    packages,
    findings,
    projectPathAliases: createGeneratedGraphPathAliases(generatedGraph),
    projectPaths,
  });

  return {
    checks,
    checkItems,
    config,
    fileOwnerLookup: createFileOwnerLookup(projects),
    findings,
    generatedGraph,
    graphRoute,
    graphRules,
    managedOutputLookup: createManagedOutputDeclarationLookup(
      createGraphCheckManagedOutputProjectContexts({
        config,
        findings,
        projectCheckerNamesByPath,
        projects,
      }),
    ),
    options,
    packages,
    preflight,
    projectCheckerNamesByPath,
    projectPaths,
    projects,
    projectsByPath,
    workspaceExports,
    workspaceLookup,
  };
}
