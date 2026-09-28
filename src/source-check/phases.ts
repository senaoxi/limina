import { isSourceKnipEnabled, type ResolvedLiminaConfig } from '#config/runner';
import { runTsconfigGovernancePhase } from './governance-phase';
import { runSourceImportAuthorityPhase } from './import-phase';
import { resolveKnipCliPath } from './knip';
import { runSourceProjectOwnershipPhase } from './project-phase';
import { finishSourceCheck } from './result-reporting';
import { runSourceRoutePhase } from './route-phase';
import { createSourceCheckState, type SourceCheckState } from './run-state';
import type { RunSourceCheckImplOptions } from './runner-types';

export type { RunSourceCheckOptions } from './runner-types';

function resolveKnipDependency(
  resolveCliPath: RunSourceCheckImplOptions['resolveKnipCliPath'],
): void {
  const resolver = resolveCliPath ?? resolveKnipCliPath;
  resolver();
}

function precheckKnipDependency(
  config: ResolvedLiminaConfig,
  options: RunSourceCheckImplOptions,
): void {
  if (options.knipRunner !== undefined) return;
  if (!isSourceKnipEnabled(config)) return;
  resolveKnipDependency(options.resolveKnipCliPath);
}

export async function prepareSourceCheck(
  config: ResolvedLiminaConfig,
  options: RunSourceCheckImplOptions = {},
): Promise<SourceCheckState> {
  precheckKnipDependency(config, options);
  const state = await createSourceCheckState(config, options);

  await runSourceRoutePhase({
    checkItems: state.checkItems,
    checks: state.checks,
    findings: state.findings,
    graphRoute: state.graphRoute,
    projectPaths: state.projectPaths,
  });
  await runTsconfigGovernancePhase({
    ambientDeclarations: state.ambientDeclarations,
    checkItems: state.checkItems,
    checks: state.checks,
    config: state.config,
    core: state.core,
    findings: state.findings,
    generatedGraph: state.generatedGraph,
    workspaceLookup: state.workspaceLookup,
  });
  return state;
}

export async function finishSourceCheckAnalysis(
  state: SourceCheckState,
): Promise<boolean> {
  await runSourceProjectOwnershipPhase({
    ambientDeclarations: state.ambientDeclarations,
    checkItems: state.checkItems,
    checks: state.checks,
    config: state.config,
    core: state.core,
    findings: state.findings,
    projects: state.projects,
    workspaceLookup: state.workspaceLookup,
  });
  await runSourceImportAuthorityPhase({
    ambientDeclarations: state.ambientDeclarations,
    checkItems: state.checkItems,
    checks: state.checks,
    config: state.config,
    core: state.core,
    findings: state.findings,
    packageOwners: state.packageOwners,
    packages: state.packages,
    preflight: state.preflight,
    rootPackage: state.rootPackage,
    sourceProjectEntries: state.sourceProjectEntries,
    workspaceLookup: state.workspaceLookup,
    workspacePathIndex: state.workspacePathIndex,
  });
  return finishSourceCheck({
    checkItems: state.checkItems,
    checks: state.checks,
    config: state.config,
    findings: state.findings,
    options: state.options,
    preflight: state.preflight,
    sourceIssues: state.sourceIssues,
    sourceProjectEntries: state.sourceProjectEntries,
  });
}
