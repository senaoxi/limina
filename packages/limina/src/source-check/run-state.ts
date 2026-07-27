import type { ResolvedLiminaConfig } from '#config/runner';
import type { AnalysisProviderSet } from '#core';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import type { ProjectInfo } from '#core/import-graph/context';
import type { PackageOwner, WorkspacePackage } from '#core/workspace/actions';
import {
  type CheckCounter,
  createCheckCounter,
  createCheckItemAccumulator,
} from '../check-reporting/stats';
import type { WorkspaceDependencyDeclaration } from '../core/packages/authority';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import type {
  ValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../core/workspace/validated-context';
import { type LiminaPreflightManager, resolvePreflight } from '../preflight';
import {
  type AmbientDeclarationIndexResult,
  createAmbientDeclarationIndex,
} from './ambient-declarations';
import type { SourceFinding } from './findings';
import { findWorkspaceRootPackage } from './import-authorization-resolution';
import {
  collectOwnerSourceModuleSets,
  type OwnerSourceModuleSet,
} from './knip/unused';
import type { SourceCheckIssue } from './report';
import {
  type RunSourceCheckImplOptions,
  SOURCE_CHECK_ITEM_NAMES,
} from './runner-types';
import {
  collectSourceProjects,
  createGeneratedProjectCheckerNamesByPath,
  createSourceProjectEntries,
} from './source-projects';
import type { SourceProjectEntry } from './source-types';

export interface SourceCheckState {
  readonly ambientDeclarations: AmbientDeclarationIndexResult;
  readonly checks: CheckCounter;
  readonly checkItems: ReturnType<typeof createCheckItemAccumulator>;
  readonly config: ResolvedLiminaConfig;
  readonly core: AnalysisProviderSet;
  readonly findings: SourceFinding[];
  readonly generatedGraph: GeneratedTsconfigGraphResult;
  readonly graphRoute: Awaited<
    ReturnType<LiminaPreflightManager['ensureSourceGraphProjectExtensions']>
  >;
  readonly options: RunSourceCheckImplOptions;
  readonly ownerModuleSets: OwnerSourceModuleSet[];
  readonly packageOwners: PackageOwner[];
  readonly packages: WorkspacePackage[];
  readonly preflight: LiminaPreflightManager;
  readonly projectPaths: string[];
  readonly projects: ProjectInfo[];
  readonly rootPackage: WorkspacePackage | null;
  readonly sourceIssues: SourceCheckIssue[];
  readonly sourceProjectEntries: SourceProjectEntry[];
  readonly workspaceContext: ValidatedWorkspaceContext;
  readonly workspaceDependencyDeclarations: WorkspaceDependencyDeclaration[];
  readonly workspaceLookup: WorkspaceLookupIndex;
  readonly workspacePathIndex: WorkspaceRegionPathIndex;
}

async function loadProjects(options: {
  graphRoute: SourceCheckState['graphRoute'];
  projectPaths: string[];
  providers: AnalysisProviderSet;
  workspaceLookup: WorkspaceLookupIndex;
}): Promise<ProjectInfo[]> {
  return collectSourceProjects({
    projectContextsByPath: options.graphRoute.projectContextsByPath,
    projectPaths: options.projectPaths,
    providers: options.providers,
    workspaceLookup: options.workspaceLookup,
  });
}

async function loadSourceProjectEntries(options: {
  generatedGraph: GeneratedTsconfigGraphResult;
  projects: ProjectInfo[];
  providers: AnalysisProviderSet;
  workspaceLookup: WorkspaceLookupIndex;
}): Promise<SourceProjectEntry[]> {
  return createSourceProjectEntries({
    checkerNamesByPath: createGeneratedProjectCheckerNamesByPath(
      options.generatedGraph,
    ),
    projects: options.projects,
    providers: options.providers,
    workspaceLookup: options.workspaceLookup,
  });
}

async function loadAmbientDeclarations(options: {
  config: ResolvedLiminaConfig;
  generatedGraph: GeneratedTsconfigGraphResult;
  workspaceContext: ValidatedWorkspaceContext;
  workspacePathIndex: WorkspaceRegionPathIndex;
}): Promise<AmbientDeclarationIndexResult> {
  return createAmbientDeclarationIndex(options);
}

export async function createSourceCheckState(
  config: ResolvedLiminaConfig,
  options: RunSourceCheckImplOptions,
): Promise<SourceCheckState> {
  const findings: SourceFinding[] = [];
  const sourceIssues: SourceCheckIssue[] = [];
  const checks = createCheckCounter();
  const checkItems = createCheckItemAccumulator(
    () => findings.length + sourceIssues.length,
    () => checks.value,
    { plannedItems: SOURCE_CHECK_ITEM_NAMES, progress: options.progress },
  );
  const preflight = resolvePreflight(config, options);
  const core = preflight.providers;
  const generatedGraph = await preflight.ensureGeneratedGraph();
  const graphRoute = await preflight.ensureSourceGraphProjectExtensions();
  const projectPaths = [...graphRoute.projectExtensionsByPath.keys()].sort();
  const workspaceLookup = await preflight.ensureWorkspaceLookupIndex();
  const projects = await loadProjects({
    graphRoute,
    projectPaths,
    providers: core,
    workspaceLookup,
  });
  const sourceProjectEntries = await loadSourceProjectEntries({
    generatedGraph,
    projects,
    providers: core,
    workspaceLookup,
  });
  const packages = await preflight.ensureWorkspacePackages();
  const workspaceContext = await preflight.ensureWorkspaceValidated();
  const workspacePathIndex = await preflight.ensureWorkspacePathIndex();
  const packageOwners = await preflight.ensurePackageOwners();
  const workspaceDependencyDeclarations =
    await preflight.ensureWorkspaceDependencyDeclarations();
  const ambientDeclarations = await loadAmbientDeclarations({
    config,
    generatedGraph,
    workspaceContext,
    workspacePathIndex,
  });

  sourceIssues.push(...ambientDeclarations.issues);
  return {
    ambientDeclarations,
    checks,
    checkItems,
    config,
    core,
    findings,
    generatedGraph,
    graphRoute,
    options,
    ownerModuleSets: collectOwnerSourceModuleSets({
      sourceProjectEntries,
      workspaceLookup,
    }),
    packageOwners,
    packages,
    preflight,
    projectPaths,
    projects,
    rootPackage: findWorkspaceRootPackage({ config, packages }),
    sourceIssues,
    sourceProjectEntries,
    workspaceContext,
    workspaceDependencyDeclarations,
    workspaceLookup,
    workspacePathIndex,
  };
}
