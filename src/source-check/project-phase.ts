import type { SourceCheckState } from './run-state';
import { addSourceProjectOwnerProblems } from './source-projects';

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

export async function runSourceProjectOwnershipPhase(
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
