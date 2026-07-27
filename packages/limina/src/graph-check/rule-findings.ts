import type { ResolvedLiminaConfig } from '#config/runner';
import { formatUnknownValue, isPlainRecord } from '#utils/values';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { GraphConfigInvalidFinding, GraphFinding } from './findings';

export function addRuleEntryConfigFinding(options: {
  config: ResolvedLiminaConfig;
  details: readonly string[];
  findings: GraphFinding[];
  reason: string;
}): void {
  options.findings.push({
    code: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
    evidence: [
      {
        label: 'graph rule configuration',
        lines: [...options.details],
      },
    ],
    facts: {
      configPath: options.config.configPath,
      kind: 'graph-rule',
    },
    filePath: options.config.configPath,
    locations: [
      {
        filePath: options.config.configPath,
        label: 'Limina config',
      },
    ],
    presentation: {
      detailLines: ['Invalid graph rule config:', ...options.details],
      reason: options.reason,
      title: 'Invalid graph rule config',
    },
    task: 'graph:check',
  } satisfies GraphConfigInvalidFinding);
}

function addRulesConfigFinding(options: {
  config: ResolvedLiminaConfig;
  findings: GraphFinding[];
  rules: unknown;
}): void {
  const reason = 'graph.rules must be an object keyed by Limina labels.';
  const value = formatUnknownValue(options.rules);
  const detailLines = [
    'Invalid graph rules config:',
    '  field: graph.rules',
    `  value: ${value}`,
    `  reason: ${reason}`,
  ];
  options.findings.push({
    code: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
    evidence: [
      { label: 'field', value: 'graph.rules' },
      { label: 'value', value },
    ],
    facts: {
      configPath: options.config.configPath,
      field: 'graph.rules',
      kind: 'graph-rule',
    },
    filePath: options.config.configPath,
    locations: [
      {
        filePath: options.config.configPath,
        label: 'Limina config',
      },
    ],
    presentation: {
      detailLines,
      reason,
      title: 'Invalid graph rules config',
    },
    task: 'graph:check',
  } satisfies GraphConfigInvalidFinding);
}

function getConfiguredRules(config: ResolvedLiminaConfig): unknown {
  if (config.graph === undefined) {
    return undefined;
  }
  return config.graph.rules;
}

export function getRulesRecord(
  config: ResolvedLiminaConfig,
  findings: GraphFinding[],
): Record<string, unknown> {
  const rules = getConfiguredRules(config);
  if (rules === undefined) {
    return {};
  }
  if (isPlainRecord(rules)) {
    return rules;
  }
  addRulesConfigFinding({ config, findings, rules });
  return {};
}
