import {
  addConditionDomainProblems,
  addDefaultCustomConditionProblems,
  createCustomConditionConsistencyContext,
} from './conditions';
import type { GraphCheckState } from './run-state';

export function runConditionDomainPhase(state: GraphCheckState): void {
  state.checkItems.start('condition domains');
  const consistencyContext = createCustomConditionConsistencyContext(
    state.projectsByPath,
    state.projectCheckerNamesByPath,
  );

  addDefaultCustomConditionProblems({
    checks: state.checks,
    config: state.config,
    consistencyContext,
    findings: state.findings,
    projects: state.projects,
  });
  addConditionDomainProblems({
    checks: state.checks,
    config: state.config,
    consistencyContext,
    findings: state.findings,
    generatedGraph: state.generatedGraph,
    projectsByPath: state.projectsByPath,
  });
  state.checkItems.record('condition domains');
}
