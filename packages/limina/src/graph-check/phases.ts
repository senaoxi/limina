import type { ProjectInfo } from '#core/import-graph/context';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import { FileOwnerLookup } from '../core/build-graph/file-owner-lookup';
import { createWorkspaceSourceBoundaryFromProjects } from '../core/typescript-semantic';
import { addDeniedReferenceProblems } from './access-denied';
import { addDtsOptionProblems } from './dts-declaration-options';
import { addTypecheckParityProblems } from './dts-typecheck-parity';
import { collectExpectedReferences } from './expected-reference-collection';
import { getProjectCheckerName } from './finding-utilities';
import type { GraphConfigInvalidFinding, GraphFinding } from './findings';
import { addReferenceCompletenessProblems } from './reference-completeness';
import { addGeneratedReferenceCycleProblems } from './reference-cycles';
import type { GraphCheckState } from './run-state';
import { addWorkspaceReferenceDependencyProblems } from './workspace-reference-dependencies';

function addGraphRouteDiagnostic(
  state: GraphCheckState,
  diagnostic: GraphCheckState['graphRoute']['diagnostics'][number],
): void {
  const filePath = diagnostic.filePath ?? state.config.configPath;

  state.findings.push({
    checkerName: diagnostic.checkerName,
    code: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
    evidence: [{ label: 'checker', value: diagnostic.checkerName }],
    facts: {
      configPath: state.config.configPath,
      kind: 'route',
    },
    filePath,
    locations: [{ filePath, label: 'checker graph route' }],
    presentation: {
      detailLines: diagnostic.detailLines,
      reason: diagnostic.reason,
      title: diagnostic.title,
    },
    task: 'graph:check',
  } satisfies GraphConfigInvalidFinding);
}

export function runGraphRoutePhase(state: GraphCheckState): void {
  state.checkItems.start('source graph routes');
  for (const diagnostic of state.graphRoute.diagnostics) {
    addGraphRouteDiagnostic(state, diagnostic);
  }

  state.checks.add(state.projectPaths.length);
  state.checkItems.record('source graph routes');
}

function createLabelDiagnosticEvidence(
  diagnostic: NonNullable<ProjectInfo['labelDiagnostic']>,
) {
  const evidence = [{ label: 'field', value: diagnostic.field }];

  if (Object.hasOwn(diagnostic, 'value')) {
    evidence.push({ label: 'value', value: JSON.stringify(diagnostic.value) });
  }

  return evidence;
}

function addProjectLabelDiagnostic(options: {
  findings: GraphFinding[];
  project: ProjectInfo;
  projectCheckerNamesByPath: ReadonlyMap<string, string>;
}): void {
  const diagnostic = options.project.labelDiagnostic;
  if (!diagnostic) {
    return;
  }

  options.findings.push({
    checkerName: getProjectCheckerName(
      options.projectCheckerNamesByPath,
      options.project.configPath,
    ),
    code: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
    evidence: createLabelDiagnosticEvidence(diagnostic),
    facts: {
      kind: 'project-label',
      projectPath: diagnostic.projectPath,
    },
    filePath: diagnostic.projectPath,
    locations: [{ filePath: diagnostic.projectPath, label: 'project' }],
    presentation: {
      detailLines: diagnostic.detailLines,
      reason: diagnostic.reason,
      title: diagnostic.title,
    },
    task: 'graph:check',
  } satisfies GraphConfigInvalidFinding);
}

function validateProjectReferences(
  state: GraphCheckState,
  project: ProjectInfo,
): void {
  addProjectLabelDiagnostic({
    findings: state.findings,
    project,
    projectCheckerNamesByPath: state.projectCheckerNamesByPath,
  });
  const checkerName = getProjectCheckerName(
    state.projectCheckerNamesByPath,
    project.configPath,
  );

  addDtsOptionProblems(
    state.config,
    project,
    state.findings,
    state.checks,
    checkerName,
  );
  addTypecheckParityProblems(
    state.config,
    project,
    state.findings,
    state.checks,
    checkerName,
    state.preflight.providers.projectConfigs,
  );
  addDeniedReferenceProblems({
    checks: state.checks,
    config: state.config,
    findings: state.findings,
    project,
    projectCheckerNamesByPath: state.projectCheckerNamesByPath,
    projectsByPath: state.projectsByPath,
    rules: state.graphRules,
    workspaceLookup: state.workspaceLookup,
  });
  addWorkspaceReferenceDependencyProblems({
    checks: state.checks,
    config: state.config,
    findings: state.findings,
    project,
    projectCheckerNamesByPath: state.projectCheckerNamesByPath,
    projectsByPath: state.projectsByPath,
    workspaceLookup: state.workspaceLookup,
  });
}

export function runProjectReferencePhase(state: GraphCheckState): void {
  state.checkItems.start('project references');
  for (const project of state.projects) {
    validateProjectReferences(state, project);
  }

  addGeneratedReferenceCycleProblems({
    checks: state.checks,
    config: state.config,
    findings: state.findings,
    projectCheckerNamesByPath: state.projectCheckerNamesByPath,
    projects: state.projects,
  });
  state.checkItems.record('project references');
}

export function runReferenceCompletenessPhase(state: GraphCheckState): void {
  state.checkItems.start('reference completeness');
  const expectedReferencesByProjectPath = collectExpectedReferences({
    config: state.config,
    fileOwnerLookup: state.fileOwnerLookup,
    generatedGraph: state.generatedGraph,
    graphRules: state.graphRules,
    importAnalysis: state.preflight.importAnalysis,
    managedOutputLookup: state.managedOutputLookup,
    packages: state.packages,
    projectCheckerNamesByPath: state.projectCheckerNamesByPath,
    projectDependencyCaches: state.preflight.providers.projectDependencies,
    findings: state.findings,
    projectPaths: state.projectPaths,
    projects: state.projects,
    projectsByPath: state.projectsByPath,
    workspaceLookup: state.workspaceLookup,
    workspaceSourceBoundary: createWorkspaceSourceBoundaryFromProjects(
      state.projects,
      {
        membership: new FileOwnerLookup(state.projects),
        isWorkspaceFile: (file) =>
          state.workspaceLookup.findOwnerForFile(file) !== null,
      },
      state.generatedGraph.sourceConfigCoverage,
    ),
  });

  addReferenceCompletenessProblems({
    checks: state.checks,
    config: state.config,
    expectedReferencesByProjectPath,
    findings: state.findings,
    generatedGraph: state.generatedGraph,
    graphRules: state.graphRules,
    projectCheckerNamesByPath: state.projectCheckerNamesByPath,
    projects: state.projects,
    projectsByPath: state.projectsByPath,
  });
  state.checkItems.record('reference completeness');
}
