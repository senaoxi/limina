import { LIMINA_CHECK_ISSUE_CODES as C } from '../issue-code-values';
import {
  defineIssueRule,
  type LiminaCheckIssueRuleDefinition,
} from './definition';

export const workspaceIssueRules: readonly LiminaCheckIssueRuleDefinition[] = [
  defineIssueRule({
    code: C.workspaceOutputCycle,
    description:
      'Workspace descriptor and output visibility does not reach a stable state.',
    task: 'workspace:validate',
  }),
  defineIssueRule({
    code: C.workspaceOutputRootInvalid,
    description:
      'A configured output root overlaps a structural workspace root.',
    task: 'workspace:validate',
  }),
  defineIssueRule({
    code: C.workspacePackageIdentityConflict,
    description:
      'Multiple activated package roots resolve to the same physical directory.',
    task: 'workspace:validate',
  }),
  defineIssueRule({
    code: C.workspaceRegionOverlap,
    description:
      'A nested pnpm workspace root overlaps a current-region workspace package.',
    task: 'workspace:validate',
  }),
  defineIssueRule({
    code: C.workspaceValidationFailed,
    description: 'Workspace validation failed without a more specific issue.',
    task: 'workspace:validate',
  }),
];
