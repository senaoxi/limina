import { isSourceKnipEnabled, type ResolvedLiminaConfig } from '#config/runner';
import { collectGeneratedSourceConfigPaths } from '#core/build-graph/runner';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import { createSourceDiagnosticFinding } from './finding-utilities';
import { addImportAuthorityOwnerConfigProblems } from './import-authority-config-findings';
import {
  collectImportAuthorityAllowRules,
  getSourceOwnerIdentity,
} from './import-authority-grants';
import { resolveKnipCliPath } from './knip';
import { isFinishSourceCheck } from './result-reporting';
import { createSourceCheckState, type SourceCheckState } from './run-state';
import type { RunSourceCheckImplOptions } from './runner-types';
import { addSourceImportProblems } from './source-import-validation';
import { addSourceProjectOwnerProblems } from './source-projects';
import { addTsconfigGovernanceProblems } from './tsconfig-governance';

type SourceRoutePhaseInput = Readonly<
  Pick<
    SourceCheckState,
    'checkItems' | 'checks' | 'findings' | 'graphRoute' | 'projectPaths'
  >
>;

async function runSourceRoutePhase(
  state: SourceRoutePhaseInput,
): Promise<void> {
  state.checkItems.start('source graph routes');
  state.findings.push(
    ...state.graphRoute.diagnostics.map((diagnostic) =>
      createSourceDiagnosticFinding({
        checkerName: diagnostic.checkerName,
        code: LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance,
        facts: {
          checkerName: diagnostic.checkerName,
          configPath: diagnostic.filePath,
          kind: 'checker-route',
        },
        filePath: diagnostic.filePath,
        lines: diagnostic.detailLines,
        reason: diagnostic.reason,
        title: diagnostic.title,
      }),
    ),
  );
  state.checks.add(state.projectPaths.length);
  state.checkItems.record('source graph routes');
}

type TsconfigGovernancePhaseInput = Readonly<
  Pick<
    SourceCheckState,
    | 'ambientDeclarations'
    | 'checkItems'
    | 'checks'
    | 'config'
    | 'core'
    | 'findings'
    | 'generatedGraph'
    | 'workspaceLookup'
  >
>;

async function runTsconfigGovernancePhase(
  state: TsconfigGovernancePhaseInput,
): Promise<void> {
  state.checkItems.start('tsconfig governance');
  await addTsconfigGovernanceProblems({
    ambientDeclarations: state.ambientDeclarations.index,
    checks: state.checks,
    config: state.config,
    configPaths: collectGeneratedSourceConfigPaths(state.generatedGraph),
    findings: state.findings,
    generatedGraph: state.generatedGraph,
    projectConfigCache: state.core.projectConfigs,
    workspaceLookup: state.workspaceLookup,
  });
  state.checkItems.record('tsconfig governance');
}

type SourceProjectOwnershipPhaseInput = Readonly<
  Pick<
    SourceCheckState,
    | 'ambientDeclarations'
    | 'checkItems'
    | 'checks'
    | 'config'
    | 'core'
    | 'findings'
    | 'projects'
    | 'workspaceLookup'
  >
>;

async function runSourceProjectOwnershipPhase(
  state: SourceProjectOwnershipPhaseInput,
): Promise<void> {
  state.checkItems.start('source project ownership');
  await addSourceProjectOwnerProblems({
    ambientDeclarations: state.ambientDeclarations.index,
    checks: state.checks,
    config: state.config,
    findings: state.findings,
    providers: state.core,
    projects: state.projects,
    workspaceLookup: state.workspaceLookup,
  });
  state.checkItems.record('source project ownership');
}

type SourceImportAuthorityPhaseInput = Readonly<
  Pick<
    SourceCheckState,
    | 'ambientDeclarations'
    | 'checkItems'
    | 'checks'
    | 'config'
    | 'core'
    | 'findings'
    | 'packageOwners'
    | 'packages'
    | 'preflight'
    | 'rootPackage'
    | 'sourceProjectEntries'
    | 'workspaceLookup'
    | 'workspacePathIndex'
  >
>;

function collectOwnerIdentities(
  state: SourceImportAuthorityPhaseInput,
): Set<string> {
  return new Set(
    state.packageOwners.map((owner) =>
      getSourceOwnerIdentity({ config: state.config, owner }),
    ),
  );
}

async function runSourceImportAuthorityPhase(
  state: SourceImportAuthorityPhaseInput,
): Promise<void> {
  state.checkItems.start('source import authority');
  const importAuthorityAllowRules = collectImportAuthorityAllowRules({
    checks: state.checks,
    config: state.config,
    findings: state.findings,
  });

  addImportAuthorityOwnerConfigProblems({
    checks: state.checks,
    config: state.config,
    findings: state.findings,
    ownerIdentities: collectOwnerIdentities(state),
  });
  addSourceImportProblems({
    ambientDeclarations: state.ambientDeclarations.index,
    checks: state.checks,
    config: state.config,
    importAnalysis: state.preflight.importAnalysis,
    importAuthorityAllowRules,
    packages: state.packages,
    pathIndex: state.workspacePathIndex,
    projectDependencyCaches: state.preflight.providers.projectDependencies,
    findings: state.findings,
    rootPackage: state.rootPackage,
    sourceProjectEntries: state.sourceProjectEntries,
    typeEvidence: state.core.typeEvidence,
    workspaceLookup: state.workspaceLookup,
  });
  state.checkItems.record('source import authority');
}

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
  if (options.knipRunner !== undefined || !isSourceKnipEnabled(config)) return;
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

export async function isFinishSourceCheckAnalysis(
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
  return isFinishSourceCheck({
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
