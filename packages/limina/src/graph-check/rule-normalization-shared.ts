import type { ResolvedLiminaConfig } from '#config/runner';
import { formatUnknownValue, isPlainRecord } from '#utils/values';
import type { GraphFinding } from './findings';
import { addRuleEntryConfigFinding } from './rule-findings';
import type {
  GraphRuleKindSelection,
  NormalizedGraphRules,
} from './rule-types';

export interface NormalizationState extends NormalizedGraphRules {
  config: ResolvedLiminaConfig;
  findings: GraphFinding[];
  include: GraphRuleKindSelection | undefined;
  projectPathAliases: Map<string, string> | undefined;
  projectPathSet: Set<string>;
}

export function addConfigFinding(options: {
  details: readonly string[];
  reason: string;
  state: NormalizationState;
}): void {
  addRuleEntryConfigFinding({
    config: options.state.config,
    details: options.details,
    findings: options.state.findings,
    reason: options.reason,
  });
}

export function isRuleKindEnabled(
  include: GraphRuleKindSelection | undefined,
  kind: keyof GraphRuleKindSelection,
): boolean {
  if (include === undefined) {
    return true;
  }
  return include[kind] !== false;
}

export function addUnknownFields(options: {
  allowedKeys: ReadonlySet<string>;
  fieldPrefix: string;
  record: Record<string, unknown>;
  reason: string;
  state: NormalizationState;
}): void {
  for (const key of Object.keys(options.record)) {
    if (options.allowedKeys.has(key)) {
      continue;
    }
    addConfigFinding({
      details: [
        `  field: ${options.fieldPrefix}.${key}`,
        `  value: ${formatUnknownValue(options.record[key])}`,
        `  reason: ${options.reason}`,
      ],
      reason: options.reason,
      state: options.state,
    });
  }
}

export function getRuleRecord(options: {
  rawLabel: string;
  rawRule: unknown;
  state: NormalizationState;
}): Record<string, unknown> | null {
  if (isPlainRecord(options.rawRule)) {
    return options.rawRule;
  }
  const reason = 'each graph rule must be an object.';
  addConfigFinding({
    details: [
      `  field: graph.rules.${options.rawLabel}`,
      `  value: ${formatUnknownValue(options.rawRule)}`,
      `  reason: ${reason}`,
    ],
    reason,
    state: options.state,
  });
  return null;
}

export function getRuleSection(options: {
  label: string;
  rawRule: Record<string, unknown>;
  section: 'allow' | 'deny';
  state: NormalizationState;
}): Record<string, unknown> | undefined {
  const value = options.rawRule[options.section];
  if (value === undefined) {
    return undefined;
  }
  if (isPlainRecord(value)) {
    return value;
  }
  const reason = `graph rule ${options.section} must be an object.`;
  addConfigFinding({
    details: [
      `  field: graph.rules.${options.label}.${options.section}`,
      `  value: ${formatUnknownValue(value)}`,
      `  reason: ${reason}`,
    ],
    reason,
    state: options.state,
  });
  return undefined;
}
