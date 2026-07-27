import type { ResolvedLiminaConfig } from '#config/runner';
import { toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import { formatCustomConditions } from './condition-subtree';
import type {
  CustomConditionConsistencyContext,
  ParsedConditionDomain,
} from './condition-types';
import type { GraphConditionDomainMismatchFinding } from './findings';

export function createDomainMismatchFinding(options: {
  config: ResolvedLiminaConfig;
  consistencyContext: CustomConditionConsistencyContext;
  domain: ParsedConditionDomain;
  entryConditions: string[];
  entryPath: string;
}): GraphConditionDomainMismatchFinding {
  const reason =
    'a condition domain declares the bundler/package resolution conditions for its declaration reference tree, so the entry project must use the same effective compilerOptions.customConditions.';
  const lines = [
    'Graph condition domain customConditions mismatch:',
    `  domain: ${options.domain.name}`,
    `  entry: ${toRelativePath(options.config.rootDir, options.entryPath)}`,
    `  expected customConditions: ${formatCustomConditions(options.domain.customConditions)}`,
    `  actual customConditions: ${formatCustomConditions(options.entryConditions)}`,
    `  reason: ${reason}`,
  ];

  return {
    checkerName: options.consistencyContext.projectCheckerNamesByPath.get(
      options.entryPath,
    ),
    code: LIMINA_CHECK_ISSUE_CODES.graphConditionDomainMismatch,
    evidence: [
      {
        label: 'expected customConditions',
        value: formatCustomConditions(options.domain.customConditions),
      },
      {
        label: 'actual customConditions',
        value: formatCustomConditions(options.entryConditions),
      },
    ],
    facts: {
      actualConditions: options.entryConditions,
      domainName: options.domain.name,
      entryProjectPath: options.entryPath,
      expectedConditions: options.domain.customConditions,
      kind: 'domain-entry',
    },
    filePath: options.entryPath,
    locations: [
      { filePath: options.config.configPath, label: 'Limina config' },
      { filePath: options.entryPath, label: 'condition domain entry' },
    ],
    presentation: {
      detailLines: lines,
      reason,
      title: 'Graph condition domain customConditions mismatch',
    },
    task: 'graph:check',
  };
}
