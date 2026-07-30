import { collectGeneratedSourceConfigPaths } from '#core/build-graph/runner';
import type { SourceCheckState } from './run-state';
import { addTsconfigGovernanceProblems } from './tsconfig-governance';

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

export async function runTsconfigGovernancePhase(
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
