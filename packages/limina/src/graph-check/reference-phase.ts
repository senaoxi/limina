import type { ProjectInfo } from '#core/import-graph/context';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import { addDeniedReferenceProblems } from './access-denied';
import {
  addDtsOptionProblems,
  addTypecheckParityProblems,
} from './dts-options';
import { getProjectCheckerName } from './finding-utils';
import type { GraphConfigInvalidFinding, GraphFinding } from './findings';
import { addGeneratedReferenceCycleProblems } from './reference-cycles';
import type { GraphCheckState } from './run-state';
import { addWorkspaceReferenceDependencyProblems } from './workspace-reference-dependencies';

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
