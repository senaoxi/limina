import type { ResolvedLiminaConfig } from '#config/runner';
import {
  isDtsProjectConfig,
  type ProjectInfo,
} from '#core/import-graph/context';
import type { CheckCounter } from '../check-reporting/stats';
import { mergeConditionFindingIdentities } from './condition-findings';
import {
  addUniqueConditionFindings,
  collectCustomConditionSubtreeSummary,
} from './condition-subtree';
import type { CustomConditionConsistencyContext } from './condition-types';
import type { GraphFinding } from './findings';

export function addDefaultCustomConditionProblems(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  consistencyContext: CustomConditionConsistencyContext;
  findings: GraphFinding[];
  projects: ProjectInfo[];
}): void {
  const findingIdentities = new Set<string>();

  for (const project of options.projects) {
    if (!isDtsProjectConfig(project.configPath)) {
      continue;
    }

    options.checks.add();
    const summary = collectCustomConditionSubtreeSummary(
      options.config,
      project,
      options.consistencyContext,
    );
    mergeConditionFindingIdentities(
      findingIdentities,
      summary.mismatchFindingIdentities,
    );
  }
  addUniqueConditionFindings(
    options.findings,
    options.consistencyContext,
    findingIdentities,
  );
}
