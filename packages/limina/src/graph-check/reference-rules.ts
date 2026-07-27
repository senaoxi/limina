import type { ResolvedLiminaConfig } from '#config/runner';
import { isDtsProjectConfig } from '#core/import-graph/context';
import { normalizeAbsolutePath } from '#utils/path';
import {
  formatUnknownValue,
  isNonEmptyString,
  isPlainRecord,
} from '#utils/values';
import path from 'pathe';
import type { GraphFinding } from './findings';
import { addRuleEntryConfigFinding } from './rule-findings';
import type {
  GraphRuleRef,
  GraphRuleRefAllow,
  GraphRuleRefDeny,
  LabelSelection,
  NormalizedGraphRules,
} from './rule-types';

export interface AddNormalizedRuleRefOptions {
  config: ResolvedLiminaConfig;
  entry: unknown;
  index: number;
  label: string;
  findings: GraphFinding[];
  projectPathAliases?: Map<string, string>;
  projectPathSet: Set<string>;
  refsByLabel: Map<string, Map<string, GraphRuleRef>>;
  ruleKind: 'allow' | 'deny';
}

function getReferenceField(options: AddNormalizedRuleRefOptions): string {
  return `graph.rules.${options.label}.${options.ruleKind}.refs[${options.index}]`;
}

function addInvalidEntryFinding(
  options: AddNormalizedRuleRefOptions,
  field: string,
): void {
  const reason = `${options.ruleKind}.refs entries must be objects with non-empty path and reason fields.`;
  addRuleEntryConfigFinding({
    config: options.config,
    details: [
      `  field: ${field}`,
      `  value: ${formatUnknownValue(options.entry)}`,
      `  reason: ${reason}`,
    ],
    findings: options.findings,
    reason,
  });
}

function addInvalidValueFinding(options: {
  field: string;
  normalizedOptions: AddNormalizedRuleRefOptions;
  reason: string;
  value: unknown;
}): void {
  addRuleEntryConfigFinding({
    config: options.normalizedOptions.config,
    details: [
      `  field: ${options.field}`,
      `  value: ${formatUnknownValue(options.value)}`,
      `  reason: ${options.reason}`,
    ],
    findings: options.normalizedOptions.findings,
    reason: options.reason,
  });
}

function resolveNormalizedRefPath(
  options: AddNormalizedRuleRefOptions,
  pathValue: string,
): string | undefined {
  const refPath = normalizeAbsolutePath(
    path.resolve(options.config.rootDir, pathValue),
  );
  if (options.projectPathSet.has(refPath)) {
    return refPath;
  }
  return options.projectPathAliases?.get(refPath);
}

function addUnreachablePathFinding(options: {
  field: string;
  normalizedOptions: AddNormalizedRuleRefOptions;
  pathValue: string;
}): void {
  const reason = `${options.normalizedOptions.ruleKind}.refs path must point to a source tsconfig or generated declaration project reachable from a checker entry.`;
  addRuleEntryConfigFinding({
    config: options.normalizedOptions.config,
    details: [
      `  field: ${options.field}.path`,
      `  path: ${options.pathValue}`,
      `  reason: ${reason}`,
    ],
    findings: options.normalizedOptions.findings,
    reason,
  });
}

function addNonDeclarationPathFinding(options: {
  field: string;
  normalizedOptions: AddNormalizedRuleRefOptions;
  pathValue: string;
}): void {
  const reason = `${options.normalizedOptions.ruleKind}.refs path must point to a tsconfig*.dts.json declaration leaf.`;
  addRuleEntryConfigFinding({
    config: options.normalizedOptions.config,
    details: [
      `  field: ${options.field}.path`,
      `  path: ${options.pathValue}`,
      `  reason: ${reason}`,
    ],
    findings: options.normalizedOptions.findings,
    reason,
  });
}

function storeNormalizedRef(options: {
  normalizedOptions: AddNormalizedRuleRefOptions;
  normalizedRefPath: string;
  reason: string;
}): void {
  const refs =
    options.normalizedOptions.refsByLabel.get(
      options.normalizedOptions.label,
    ) ?? new Map<string, GraphRuleRef>();
  refs.set(options.normalizedRefPath, {
    path: options.normalizedRefPath,
    reason: options.reason.trim(),
  });
  options.normalizedOptions.refsByLabel.set(
    options.normalizedOptions.label,
    refs,
  );
}

function isReachableRefPath(
  normalizedRefPath: string | undefined,
  options: AddNormalizedRuleRefOptions,
): normalizedRefPath is string {
  if (normalizedRefPath === undefined) {
    return false;
  }
  return options.projectPathSet.has(normalizedRefPath);
}

function validateResolvedRef(options: {
  field: string;
  normalizedOptions: AddNormalizedRuleRefOptions;
  pathValue: string;
  reasonValue: string;
}): void {
  const normalizedRefPath = resolveNormalizedRefPath(
    options.normalizedOptions,
    options.pathValue,
  );
  if (!isReachableRefPath(normalizedRefPath, options.normalizedOptions)) {
    addUnreachablePathFinding(options);
    return;
  }
  if (!isDtsProjectConfig(normalizedRefPath)) {
    addNonDeclarationPathFinding(options);
    return;
  }
  storeNormalizedRef({
    normalizedOptions: options.normalizedOptions,
    normalizedRefPath,
    reason: options.reasonValue,
  });
}

interface ParsedRuleRefEntry {
  pathValue: string;
  reasonValue: string;
}

function parseRuleRefRecord(options: {
  field: string;
  normalizedOptions: AddNormalizedRuleRefOptions;
  record: Record<string, unknown>;
}): ParsedRuleRefEntry | null {
  const pathValue = options.record.path;
  if (!isNonEmptyString(pathValue)) {
    addInvalidValueFinding({
      field: `${options.field}.path`,
      normalizedOptions: options.normalizedOptions,
      reason: `${options.normalizedOptions.ruleKind}.refs path is required and must be a non-empty string.`,
      value: pathValue,
    });
    return null;
  }
  const reasonValue = options.record.reason;
  if (!isNonEmptyString(reasonValue)) {
    addInvalidValueFinding({
      field: `${options.field}.reason`,
      normalizedOptions: options.normalizedOptions,
      reason: `${options.normalizedOptions.ruleKind}.refs reason is required and must be a non-empty string.`,
      value: reasonValue,
    });
    return null;
  }
  return { pathValue, reasonValue };
}

function parseRuleRefEntry(
  options: AddNormalizedRuleRefOptions,
  field: string,
): ParsedRuleRefEntry | null {
  if (!isPlainRecord(options.entry)) {
    addInvalidEntryFinding(options, field);
    return null;
  }
  return parseRuleRefRecord({
    field,
    normalizedOptions: options,
    record: options.entry,
  });
}

export function addNormalizedRuleRef(
  options: AddNormalizedRuleRefOptions,
): void {
  const field = getReferenceField(options);
  const parsed = parseRuleRefEntry(options, field);
  if (parsed === null) {
    return;
  }
  validateResolvedRef({
    field,
    normalizedOptions: options,
    pathValue: parsed.pathValue,
    reasonValue: parsed.reasonValue,
  });
}

function getSelectedLabels(labels: LabelSelection): readonly string[] {
  if (labels === null) {
    return [];
  }
  return typeof labels === 'string' ? [labels] : labels;
}

function getLabelRefRule<T extends GraphRuleRef>(
  refsByLabel: Map<string, Map<string, T>>,
  label: string,
  targetProjectPath: string,
): T | null {
  const refs = refsByLabel.get(label);
  if (refs === undefined) {
    return null;
  }
  return refs.get(targetProjectPath) ?? null;
}

function getRefRule<T extends GraphRuleRef>(
  refsByLabel: Map<string, Map<string, T>>,
  labels: LabelSelection,
  targetProjectPath: string,
): T | null {
  for (const label of getSelectedLabels(labels)) {
    const rule = getLabelRefRule(refsByLabel, label, targetProjectPath);
    if (rule !== null) {
      return rule;
    }
  }
  return null;
}

export function getDeniedRefRule(
  rules: NormalizedGraphRules,
  labels: LabelSelection,
  targetProjectPath: string,
): GraphRuleRefDeny | null {
  return getRefRule(rules.refsByLabel, labels, targetProjectPath);
}

export function getAllowedRefRule(
  rules: NormalizedGraphRules,
  labels: LabelSelection,
  targetProjectPath: string,
): GraphRuleRefAllow | null {
  return getRefRule(rules.allowRefsByLabel, labels, targetProjectPath);
}
