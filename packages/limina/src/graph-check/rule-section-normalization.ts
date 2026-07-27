import { formatUnknownValue } from '#utils/values';
import { addNormalizedDep } from './dependency-rule-normalization';
import { addNormalizedRuleRef } from './reference-rules';
import {
  addConfigFinding,
  addUnknownFields,
  isRuleKindEnabled,
  type NormalizationState,
} from './rule-normalization-shared';
import type { GraphRuleRef } from './rule-types';

const graphRuleAllowKeys = new Set(['refs']);
const graphRuleDenyKeys = new Set(['deps', 'refs']);

type RuleSection = 'allow' | 'deny';

function getRefMap(
  state: NormalizationState,
  ruleKind: RuleSection,
): Map<string, Map<string, GraphRuleRef>> {
  return ruleKind === 'allow' ? state.allowRefsByLabel : state.refsByLabel;
}

function addReferenceEntries(options: {
  entries: readonly unknown[];
  label: string;
  ruleKind: RuleSection;
  state: NormalizationState;
}): void {
  const refsByLabel = getRefMap(options.state, options.ruleKind);
  for (const [index, entry] of options.entries.entries()) {
    addNormalizedRuleRef({
      config: options.state.config,
      entry,
      findings: options.state.findings,
      index,
      label: options.label,
      projectPathAliases: options.state.projectPathAliases,
      projectPathSet: options.state.projectPathSet,
      refsByLabel,
      ruleKind: options.ruleKind,
    });
  }
}

function addInvalidArrayFinding(options: {
  field: string;
  reason: string;
  state: NormalizationState;
  value: unknown;
}): void {
  addConfigFinding({
    details: [
      `  field: ${options.field}`,
      `  value: ${formatUnknownValue(options.value)}`,
      `  reason: ${options.reason}`,
    ],
    reason: options.reason,
    state: options.state,
  });
}

function normalizeReferenceValue(options: {
  label: string;
  ruleKind: RuleSection;
  state: NormalizationState;
  value: unknown;
}): void {
  if (options.value === undefined) {
    return;
  }
  if (!Array.isArray(options.value)) {
    const reason = `${options.ruleKind}.refs must be an array.`;
    addInvalidArrayFinding({
      field: `graph.rules.${options.label}.${options.ruleKind}.refs`,
      reason,
      state: options.state,
      value: options.value,
    });
    return;
  }
  addReferenceEntries({
    entries: options.value,
    label: options.label,
    ruleKind: options.ruleKind,
    state: options.state,
  });
}

function addDependencyEntries(options: {
  entries: readonly unknown[];
  label: string;
  state: NormalizationState;
}): void {
  for (const [index, entry] of options.entries.entries()) {
    addNormalizedDep({
      config: options.state.config,
      depsByLabel: options.state.depsByLabel,
      entry,
      findings: options.state.findings,
      index,
      label: options.label,
    });
  }
}

function normalizeDependencyValue(options: {
  label: string;
  state: NormalizationState;
  value: unknown;
}): void {
  if (options.value === undefined) {
    return;
  }
  if (!Array.isArray(options.value)) {
    const reason = 'deny.deps must be an array.';
    addInvalidArrayFinding({
      field: `graph.rules.${options.label}.deny.deps`,
      reason,
      state: options.state,
      value: options.value,
    });
    return;
  }
  addDependencyEntries({
    entries: options.value,
    label: options.label,
    state: options.state,
  });
}

function normalizeDenyRefs(
  label: string,
  deny: Record<string, unknown>,
  state: NormalizationState,
): void {
  if (!isRuleKindEnabled(state.include, 'refs')) {
    return;
  }
  normalizeReferenceValue({
    label,
    ruleKind: 'deny',
    state,
    value: deny.refs,
  });
}

function normalizeDenyDeps(
  label: string,
  deny: Record<string, unknown>,
  state: NormalizationState,
): void {
  if (!isRuleKindEnabled(state.include, 'deps')) {
    return;
  }
  normalizeDependencyValue({ label, state, value: deny.deps });
}

export function normalizeDenySection(
  label: string,
  deny: Record<string, unknown> | undefined,
  state: NormalizationState,
): void {
  if (deny === undefined) {
    return;
  }
  addUnknownFields({
    allowedKeys: graphRuleDenyKeys,
    fieldPrefix: `graph.rules.${label}.deny`,
    record: deny,
    reason: 'unknown graph rule deny field.',
    state,
  });
  normalizeDenyRefs(label, deny, state);
  normalizeDenyDeps(label, deny, state);
}

function normalizeAllowRefs(
  label: string,
  allow: Record<string, unknown>,
  state: NormalizationState,
): void {
  if (!isRuleKindEnabled(state.include, 'refs')) {
    return;
  }
  normalizeReferenceValue({
    label,
    ruleKind: 'allow',
    state,
    value: allow.refs,
  });
}

export function normalizeAllowSection(
  label: string,
  allow: Record<string, unknown> | undefined,
  state: NormalizationState,
): void {
  if (allow === undefined) {
    return;
  }
  addUnknownFields({
    allowedKeys: graphRuleAllowKeys,
    fieldPrefix: `graph.rules.${label}.allow`,
    record: allow,
    reason: 'unknown graph rule allow field.',
    state,
  });
  normalizeAllowRefs(label, allow, state);
}
