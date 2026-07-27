import type { LiminaCheckIssueCode } from '../issue-code-values';
import type { LiminaCheckTaskName } from '../snapshot';

export type LiminaCheckIssueRuleStatus = 'active' | 'planned' | 'retired';

export interface LiminaCheckIssueRuleMetadata {
  code: LiminaCheckIssueCode;
  description: string;
  status: LiminaCheckIssueRuleStatus;
  task: LiminaCheckTaskName;
}

export type LiminaCheckIssueRuleDefinition = LiminaCheckIssueRuleMetadata;

export function defineIssueRule(options: {
  code: LiminaCheckIssueCode;
  description: string;
  status?: LiminaCheckIssueRuleStatus;
  task: LiminaCheckTaskName;
}): LiminaCheckIssueRuleDefinition {
  return {
    code: options.code,
    description: options.description,
    status: options.status ?? 'active',
    task: options.task,
  };
}
