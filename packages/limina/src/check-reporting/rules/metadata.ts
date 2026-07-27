import type { LiminaCheckIssueCode } from '../issue-code-values';
import { checkerPackageProofIssueRules } from './checker-package-proof';
import type { LiminaCheckIssueRuleDefinition } from './definition';
import { graphIssueRules } from './graph';
import { releaseSourceIssueRules } from './release-source';
import { workspaceIssueRules } from './workspace';

export type {
  LiminaCheckIssueRuleDefinition,
  LiminaCheckIssueRuleMetadata,
  LiminaCheckIssueRuleStatus,
} from './definition';

const definitions: readonly LiminaCheckIssueRuleDefinition[] = [
  ...checkerPackageProofIssueRules,
  ...graphIssueRules,
  ...releaseSourceIssueRules,
  ...workspaceIssueRules,
];

export const LIMINA_CHECK_ISSUE_RULE_METADATA: Readonly<
  Record<LiminaCheckIssueCode, LiminaCheckIssueRuleDefinition>
> = Object.fromEntries(
  definitions.map((definition) => [definition.code, definition]),
) as Record<LiminaCheckIssueCode, LiminaCheckIssueRuleDefinition>;
