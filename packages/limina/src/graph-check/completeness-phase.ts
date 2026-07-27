import { collectExpectedReferences } from './expected-reference-collection';
import { addReferenceCompletenessProblems } from './reference-completeness';
import type { GraphCheckState } from './run-state';

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
    findings: state.findings,
    projectPaths: state.projectPaths,
    projects: state.projects,
    projectsByPath: state.projectsByPath,
    workspaceExports: state.workspaceExports,
    workspaceLookup: state.workspaceLookup,
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
