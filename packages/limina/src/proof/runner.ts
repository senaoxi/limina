import type { ResolvedLiminaConfig } from '#config/runner';
import { isBuildGraphConfigPath } from '#core/tsconfig/actions';
import path from 'pathe';
import {
  addAllowlistCoverage,
  addAllowlistFindings,
  collectConfiguredAllowlistEntries,
} from './allowlist';
import { addBuildGraphConfigFindings } from './build-graph-config-findings';
import { collectProjectContextsByPath } from './checker-context';
import {
  collectCheckerCoverageTargets,
  createProofCheckerRouteFinding,
} from './checker-targets';
import { cloneCoverageByFile, type CoverageSource } from './coverage';
import { collectCoverage } from './coverage-collection';
import { addDtsConfigFindings } from './declaration-config-findings';
import { addDefaultTsconfigEnvironmentFindings } from './default-tsconfig-environment-findings';
import { addDefaultTsconfigShapeFindings } from './default-tsconfig-shape-findings';
import type { ProofFinding } from './findings';
import {
  addDuplicateGraphCoverageFindings,
  collectConfigFileOwners,
} from './graph-coverage-ownership';
import {
  createProofRunState,
  finishProofPhase,
  type ProofPhase,
  type ProofRunState,
} from './run-state';
import type { RunProofCheckImplOptions } from './runner-types';
import {
  addSourceBoundaryMismatchFindings,
  addUncoveredSourceFindings,
} from './source-coverage-findings';
import { addSourceReferenceRoleFindings } from './source-reference-findings';
import { logProofSuccess } from './success-report';
import { addDuplicateTypecheckOwnershipFindings } from './typecheck-ownership';

export type { RunProofCheckOptions } from './runner-types';

async function addRouteFindings(state: ProofRunState): Promise<void> {
  const [graphCollection, entryCollection] = await Promise.all([
    state.preflight.ensureGraphProjectRoutes(),
    state.preflight.ensureCheckerEntryProjectRoutes(),
  ]);

  state.findings.push(
    ...graphCollection.diagnostics.map((diagnostic) =>
      createProofCheckerRouteFinding({
        checkerName: diagnostic.checkerName,
        diagnostic,
        projection: 'graph',
        workspaceLookup: state.workspaceLookup,
      }),
    ),
    ...entryCollection.diagnostics.map((diagnostic) =>
      createProofCheckerRouteFinding({
        checkerName: diagnostic.checkerName,
        diagnostic,
        projection: 'checker-entry',
        workspaceLookup: state.workspaceLookup,
      }),
    ),
  );
}

function addProjectConfigFindings(state: ProofRunState): void {
  const projectContexts = collectProjectContextsByPath(
    state.config,
    state.entryRoutes,
  );
  const defaultTsconfigPaths = state.ordinaryConfigPaths.filter(
    (configPath) => path.basename(configPath) === 'tsconfig.json',
  );

  addDtsConfigFindings({
    config: state.config,
    dtsConfigPaths: state.dtsConfigPaths,
    findings: state.findings,
    graphProjectPaths: new Set(state.entryProjectPaths),
    projectContextsByPath: projectContexts,
    virtualFiles: state.generatedGraph.generatedFiles,
    workspaceLookup: state.workspaceLookup,
  });
  addBuildGraphConfigFindings({
    buildGraphConfigPaths: state.entryProjectPaths.filter(
      isBuildGraphConfigPath,
    ),
    config: state.config,
    findings: state.findings,
    virtualFiles: state.generatedGraph.generatedFiles,
    workspaceLookup: state.workspaceLookup,
  });
  addDefaultTsconfigShapeFindings({
    config: state.config,
    findings: state.findings,
    tsconfigPaths: defaultTsconfigPaths,
    workspaceLookup: state.workspaceLookup,
  });
  addSourceReferenceRoleFindings({
    config: state.config,
    findings: state.findings,
    ordinaryConfigPaths: state.ordinaryConfigPaths,
    workspaceLookup: state.workspaceLookup,
  });
  addDefaultTsconfigEnvironmentFindings({
    config: state.config,
    findings: state.findings,
    ordinaryConfigPaths: state.ordinaryConfigPaths,
    workspaceLookup: state.workspaceLookup,
  });
  addDuplicateTypecheckOwnershipFindings({
    config: state.config,
    findings: state.findings,
    generatedGraph: state.generatedGraph,
    ordinaryConfigPaths: state.ordinaryConfigPaths,
    workspaceLookup: state.workspaceLookup,
  });
}

async function runProjectConfigPhase(state: ProofRunState): Promise<boolean> {
  await addRouteFindings(state);
  state.checkItems.start('project routes and configs');
  addProjectConfigFindings(state);
  state.checks.add(
    state.entryProjectPaths.length + state.dtsConfigPaths.length,
  );
  state.checkItems.record('project routes and configs');
  return finishProofPhase(state);
}

async function runCheckerTargetPhase(state: ProofRunState): Promise<boolean> {
  const collection = collectCheckerCoverageTargets(
    state.config,
    state.generatedGraph,
    state.workspaceLookup,
  );

  state.checkItems.start('checker coverage targets');
  state.findings.push(...collection.findings);
  state.checkerTargets = collection.targets;
  state.checks.add(collection.targets.length);
  state.checkItems.record('checker coverage targets');
  return finishProofPhase(state);
}

function addCoverageFindings(options: {
  baseCoverageByFile: Map<string, CoverageSource[]>;
  coverageByFile: Map<string, CoverageSource[]>;
  outsideCoverage: Map<string, CoverageSource[]>;
  sourceFiles: Set<string>;
  state: ProofRunState;
}): void {
  const uncoveredFindings: ProofFinding[] = [];

  addUncoveredSourceFindings({
    checkerTargets: options.state.checkerTargets,
    config: options.state.config,
    coverageByFile: options.coverageByFile,
    findings: uncoveredFindings,
    sourceFiles: options.sourceFiles,
    workspaceLookup: options.state.workspaceLookup,
  });
  options.state.findings.unshift(...uncoveredFindings);
  addDuplicateGraphCoverageFindings({
    config: options.state.config,
    findings: options.state.findings,
    ownersByFile: collectConfigFileOwners({
      config: options.state.config,
      graphRoutes: options.state.graphRoutes,
      sourceFiles: options.sourceFiles,
      virtualFiles: options.state.generatedGraph.generatedFiles,
    }),
    workspaceLookup: options.state.workspaceLookup,
  });
  addAllowlistFindings({
    allowlistEntries: collectConfiguredAllowlistEntries(options.state.config)
      .entries,
    baseCoverageByFile: options.baseCoverageByFile,
    config: options.state.config,
    findings: options.state.findings,
    sourceFiles: options.sourceFiles,
  });
  addSourceBoundaryMismatchFindings({
    config: options.state.config,
    findings: options.state.findings,
    outsideSourceCoverageByFile: options.outsideCoverage,
    workspaceLookup: options.state.workspaceLookup,
  });
}

async function runCoveragePhase(state: ProofRunState): Promise<boolean> {
  const sourceFiles = await state.preflight.ensureExpectedSourceFiles();
  const allowlist = collectConfiguredAllowlistEntries(state.config);

  state.checkItems.start('proof allowlist');
  state.findings.push(...allowlist.findings);
  state.checks.add(allowlist.entries.length);
  state.checkItems.record('proof allowlist');
  state.checkItems.start('source coverage');
  const outsideCoverage = new Map<string, CoverageSource[]>();
  const baseCoverageByFile = collectCoverage({
    checkerTargets: state.checkerTargets,
    config: state.config,
    graphRoutes: state.graphRoutes,
    outsideSourceCoverageByFile: outsideCoverage,
    sourceFiles,
    virtualFiles: state.generatedGraph.generatedFiles,
  });
  const coverageByFile = cloneCoverageByFile(baseCoverageByFile);

  addAllowlistCoverage({
    allowlistEntries: allowlist.entries,
    coverageByFile,
    sourceFiles,
  });
  addCoverageFindings({
    baseCoverageByFile,
    coverageByFile,
    outsideCoverage,
    sourceFiles,
    state,
  });
  state.checks.add(sourceFiles.size);
  state.checkItems.record('source coverage');

  if (!(await finishProofPhase(state))) {
    return false;
  }

  logProofSuccess({ coverageByFile, sourceFiles, state });
  state.options.onStats?.({
    items: state.checkItems.getItems(),
    passed: state.checks.value,
    total: state.checks.value,
  });
  return true;
}

const proofPhases: ProofPhase[] = [
  runProjectConfigPhase,
  runCheckerTargetPhase,
  runCoveragePhase,
];

async function executeProofPhases(state: ProofRunState): Promise<boolean> {
  for (const phase of proofPhases) {
    if (!(await phase(state))) {
      return false;
    }
  }

  return true;
}

export async function runProofCheckImpl(
  config: ResolvedLiminaConfig,
  options: RunProofCheckImplOptions = {},
): Promise<boolean> {
  return executeProofPhases(await createProofRunState(config, options));
}
