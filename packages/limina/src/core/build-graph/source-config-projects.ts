import type { CheckerProjectConfigCache } from '#checkers';
import type { ResolvedLiminaInputs } from '#config/runner';
import { toRelativePath } from '#utils/path';
import { TypeScriptConfigInputError } from '../../checker/project-base';
import type { SourceConfigCoverageIndex } from '../../domain/analysis/native-coverage';
import { AnalysisInputDriftError } from '../analysis-cache/contracts';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import type {
  AutoScopeProject,
  SourceConfigCandidate,
} from './auto-checker-types';
import type { CheckerOwnershipPlan } from './checker-ownership-types';
import { recordFrameworkSourceAuthority } from './framework-source-authority';
import {
  freezeSemanticProject,
  type FrozenSemanticProject,
  prepareDiagnosticNativeProject,
} from './locked-semantic-project';
import {
  sourceConfigBasis,
  SourceConfigDiscovery,
} from './source-config-discovery';
import { sourcePackageScopeProblems } from './source-package-scope';
import type { AutoScope } from './types';

interface PreparationInput {
  activatedRegions: WorkspaceRegionPathIndex;
  activeEntryPaths: readonly string[];
  cache?: NativeAnalysisCache;
  candidates: ReadonlyMap<string, SourceConfigCandidate>;
  config: ResolvedLiminaInputs;
  plan: CheckerOwnershipPlan;
  projectConfigCache?: CheckerProjectConfigCache;
  scopes: readonly AutoScope[];
}

interface PreparedSourceConfigProjects {
  coverage: SourceConfigCoverageIndex;
  frozenProjectsByConfigPath: Map<string, FrozenSemanticProject>;
  preparationFailures: Map<string, unknown>;
  problems: string[];
  projectByConfigPath: Map<string, AutoScopeProject>;
  unavailableProjects: AutoScopeProject[];
}

function createSourceDiscovery(input: PreparationInput): SourceConfigDiscovery {
  const discovery = new SourceConfigDiscovery(
    input.activeEntryPaths,
    'source-config-lifecycle-v2',
  );
  for (const scope of input.scopes)
    for (const configPath of scope.collection.packageRootBySourcePath.keys())
      discovery.begin(configPath);
  for (const configPath of input.plan.solutions.keys()) {
    if (input.candidates.has(configPath)) continue;
    discovery.parsed(configPath, [], {
      isSolution: true,
      basis: input.scopes.flatMap(
        (scope) =>
          scope.collection.solutionReferencesBySourcePath.get(configPath) ?? [],
      ),
    });
  }
  return discovery;
}

function observeProjectConfig(
  cache: NativeAnalysisCache | undefined,
  project: AutoScopeProject,
): void {
  if (cache === undefined) return;
  const { configPath, configClosure, virtualFiles } = project;
  const paths = configClosure.map(({ filePath }) => filePath);
  cache.configClosures.set(configPath, paths);
  cache.inputs.observeConfig(configClosure, virtualFiles);
  if (cache.previous !== undefined && !cache.inputs.configCurrent(paths))
    cache.invalidateSourceConfig(configPath);
}

function collectDiagnosticProject(
  input: Parameters<typeof prepareDiagnosticNativeProject>[0],
  discovery: SourceConfigDiscovery,
  unavailableProjects: AutoScopeProject[],
): void {
  let diagnostic: ReturnType<typeof prepareDiagnosticNativeProject>;
  try {
    diagnostic = prepareDiagnosticNativeProject(input);
  } catch (error) {
    if (error instanceof AnalysisInputDriftError) throw error;
    return;
  }
  const { project, members } = diagnostic;
  discovery.parsed(project.configPath, members, {
    isSolution: false,
    basis: sourceConfigBasis(project),
  });
  unavailableProjects.push(project);
}

function removeEmptyProjects(plan: CheckerOwnershipPlan, empty: Set<string>) {
  for (const path of empty) plan.typeConfigs.delete(path);
  for (const solution of plan.solutions.values())
    solution.sourceConfigPaths = solution.sourceConfigPaths.filter(
      (path) => !empty.has(path),
    );
}

function unavailableExtendsProblem(
  rootDirectory: string,
  candidate: SourceConfigCandidate,
  error: unknown,
): string | undefined {
  if (
    !(error instanceof TypeScriptConfigInputError) ||
    !Object.hasOwn(candidate.configObject, 'extends') ||
    error.diagnosticCodes.every((code) => code !== 5083 && code !== 6053)
  )
    return undefined;
  return [
    'Unavailable auto checker extends config:',
    `  config: ${toRelativePath(rootDirectory, candidate.configPath)}`,
    `  reason: ${error.message}`,
    '  fix: generate or install the extended config and correct its diagnostics, then rerun `limina graph prepare`.',
  ].join('\n');
}

export function prepareSourceConfigProjects(
  input: PreparationInput,
): PreparedSourceConfigProjects {
  const discovery = createSourceDiscovery(input);
  const preparationFailures = new Map<string, unknown>();
  const projectByConfigPath = new Map<string, AutoScopeProject>();
  const frozenProjectsByConfigPath = new Map<string, FrozenSemanticProject>();
  const problems: string[] = [];
  const unavailableProjects: AutoScopeProject[] = [];
  const empty = new Set<string>();
  for (const candidate of input.candidates.values()) {
    const { configPath, configObject } = candidate;
    const state = input.plan.typeConfigs.get(configPath)!;
    const authority = state.frozenSemanticAuthority;
    const context = {
      ...input,
      candidate,
      includeFrameworkCandidates: state.authoritativeOwner === undefined,
    };
    if (
      authority === undefined ||
      state.semanticAuthorityUnavailable !== undefined
    ) {
      collectDiagnosticProject(
        { ...context, includeFrameworkCandidates: true },
        discovery,
        unavailableProjects,
      );
      continue;
    }
    try {
      if (authority.family === 'typescript')
        input.cache?.recordBundledSourceConfigAuthority({
          configPath,
          family: authority.family,
          source: authority.source,
        });
      const { frozen, members } = freezeSemanticProject({
        ...context,
        authority,
      });
      observeProjectConfig(input.cache, frozen.project);
      discovery.parsed(configPath, members, {
        isSolution: false,
        basis: sourceConfigBasis(frozen.project),
      });
      if (members.length === 0 && !Object.hasOwn(configObject, 'include')) {
        empty.add(configPath);
        continue;
      }
      const scopeProblems = sourcePackageScopeProblems(
        input.config,
        input.activatedRegions,
        configPath,
        members,
      );
      if (scopeProblems.length > 0) {
        problems.push(...scopeProblems);
        state.semanticAuthorityUnavailable = 'invalid-source-package-scope';
        continue;
      }
      recordFrameworkSourceAuthority({
        cache: input.cache,
        config: input.config,
        frozen,
      });
      projectByConfigPath.set(configPath, frozen.project);
      frozenProjectsByConfigPath.set(configPath, frozen);
    } catch (error) {
      if (error instanceof AnalysisInputDriftError) throw error;
      preparationFailures.set(configPath, error);
      if (state.authoritativeOwner === undefined) {
        const problem = unavailableExtendsProblem(
          input.config.rootDir,
          candidate,
          error,
        );
        if (problem !== undefined) problems.push(problem);
      }
      if (
        authority.family !== 'typescript' &&
        !(error instanceof TypeScriptConfigInputError)
      )
        collectDiagnosticProject(
          { ...context, includeFrameworkCandidates: true },
          discovery,
          unavailableProjects,
        );
    }
  }
  removeEmptyProjects(input.plan, empty);
  if (input.scopes.every((scope) => !scope.collection.incompleteTopology))
    discovery.close();
  return {
    coverage: discovery.snapshot(),
    frozenProjectsByConfigPath,
    problems,
    preparationFailures,
    projectByConfigPath,
    unavailableProjects,
  };
}
