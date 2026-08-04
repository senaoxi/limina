import { isSourceKnipEnabled } from '#config/runner';
import type { SourceCheckState } from '../run-state';
import { addKnipBackedSourceProblems } from './source-validation';

type KnipSourcePhaseInput = Readonly<
  Pick<
    SourceCheckState,
    | 'checkItems'
    | 'checks'
    | 'config'
    | 'findings'
    | 'generatedGraph'
    | 'options'
    | 'ownerModuleSets'
    | 'packages'
    | 'sourceIssues'
    | 'workspaceDependencyDeclarations'
  >
>;

export async function runKnipSourcePhase(
  state: KnipSourcePhaseInput,
): Promise<void> {
  if (!isSourceKnipEnabled(state.config)) {
    state.checkItems.skip('knip source usage', 'source.knip is disabled');
    return;
  }
  state.checkItems.start('knip source usage');
  await addKnipBackedSourceProblems({
    checks: state.checks,
    config: state.config,
    findings: state.findings,
    generatedGraph: state.generatedGraph,
    knipRunner: state.options.knipRunner,
    ownerModuleSets: state.ownerModuleSets,
    sourceIssues: state.sourceIssues,
    workspaceDependencyDeclarations: state.workspaceDependencyDeclarations,
    workspacePackages: state.packages,
  });
  state.checkItems.record('knip source usage');
}
