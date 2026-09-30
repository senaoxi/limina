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
  GraphRuleReference,
  GraphRuleReferenceAllow,
  GraphRuleReferenceDeny,
  LabelSelection,
  NormalizedGraphRules,
} from './rule-types';

export interface AddNormalizedRuleReferenceOptions {
  config: ResolvedLiminaConfig;
  entry: unknown;
  index: number;
  label: string;
  findings: GraphFinding[];
  projectPathAliases?: Map<string, string>;
  projectPathSet: Set<string>;
  refsByLabel: Map<string, Map<string, GraphRuleReference>>;
  ruleKind: 'allow' | 'deny';
}

function getReferenceField(options: AddNormalizedRuleReferenceOptions): string {
  return `graph.rules.${options.label}.${options.ruleKind}.refs[${options.index}]`;
}

function addInvalidEntryFinding(
  options: AddNormalizedRuleReferenceOptions,
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
  normalizedOptions: AddNormalizedRuleReferenceOptions;
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

function resolveNormalizedReferencePath(
  options: AddNormalizedRuleReferenceOptions,
  pathValue: string,
): string | undefined {
  const referencePath = normalizeAbsolutePath(
    path.resolve(options.config.rootDir, pathValue),
  );
  return options.projectPathSet.has(referencePath)
    ? referencePath
    : options.projectPathAliases?.get(referencePath);
}

function addUnreachablePathFinding(options: {
  field: string;
  normalizedOptions: AddNormalizedRuleReferenceOptions;
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
  normalizedOptions: AddNormalizedRuleReferenceOptions;
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

function storeNormalizedReference(options: {
  normalizedOptions: AddNormalizedRuleReferenceOptions;
  normalizedRefPath: string;
  reason: string;
}): void {
  const references =
    options.normalizedOptions.refsByLabel.get(
      options.normalizedOptions.label,
    ) ?? new Map<string, GraphRuleReference>();
  references.set(options.normalizedRefPath, {
    path: options.normalizedRefPath,
    reason: options.reason.trim(),
  });
  options.normalizedOptions.refsByLabel.set(
    options.normalizedOptions.label,
    references,
  );
}

function isReachableReferencePath(
  normalizedReferencePath: string | undefined,
  options: AddNormalizedRuleReferenceOptions,
): normalizedReferencePath is string {
  return (
    normalizedReferencePath !== undefined &&
    options.projectPathSet.has(normalizedReferencePath)
  );
}

function validateResolvedReference(options: {
  field: string;
  normalizedOptions: AddNormalizedRuleReferenceOptions;
  pathValue: string;
  reasonValue: string;
}): void {
  const normalizedReferencePath = resolveNormalizedReferencePath(
    options.normalizedOptions,
    options.pathValue,
  );
  if (
    !isReachableReferencePath(
      normalizedReferencePath,
      options.normalizedOptions,
    )
  ) {
    addUnreachablePathFinding(options);
    return;
  }
  if (!isDtsProjectConfig(normalizedReferencePath)) {
    addNonDeclarationPathFinding(options);
    return;
  }
  storeNormalizedReference({
    normalizedOptions: options.normalizedOptions,
    normalizedRefPath: normalizedReferencePath,
    reason: options.reasonValue,
  });
}

interface ParsedRuleReferenceEntry {
  pathValue: string;
  reasonValue: string;
}

function parseRuleReferenceRecord(options: {
  field: string;
  normalizedOptions: AddNormalizedRuleReferenceOptions;
  record: Record<string, unknown>;
}): ParsedRuleReferenceEntry | null {
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

function parseRuleReferenceEntry(
  options: AddNormalizedRuleReferenceOptions,
  field: string,
): ParsedRuleReferenceEntry | null {
  if (!isPlainRecord(options.entry)) {
    addInvalidEntryFinding(options, field);
    return null;
  }
  return parseRuleReferenceRecord({
    field,
    normalizedOptions: options,
    record: options.entry,
  });
}

export function addNormalizedRuleReference(
  options: AddNormalizedRuleReferenceOptions,
): void {
  const field = getReferenceField(options);
  const parsed = parseRuleReferenceEntry(options, field);
  if (parsed === null) {
    return;
  }
  validateResolvedReference({
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

function getLabelReferenceRule<T extends GraphRuleReference>(
  referencesByLabel: Map<string, Map<string, T>>,
  label: string,
  targetProjectPath: string,
): T | null {
  const references = referencesByLabel.get(label);
  return references === undefined
    ? null
    : (references.get(targetProjectPath) ?? null);
}

function getReferenceRule<T extends GraphRuleReference>(
  referencesByLabel: Map<string, Map<string, T>>,
  labels: LabelSelection,
  targetProjectPath: string,
): T | null {
  for (const label of getSelectedLabels(labels)) {
    const rule = getLabelReferenceRule(
      referencesByLabel,
      label,
      targetProjectPath,
    );
    if (rule !== null) {
      return rule;
    }
  }
  return null;
}

export function getDeniedReferenceRule(
  rules: NormalizedGraphRules,
  labels: LabelSelection,
  targetProjectPath: string,
): GraphRuleReferenceDeny | null {
  return getReferenceRule(rules.refsByLabel, labels, targetProjectPath);
}

export function getAllowedReferenceRule(
  rules: NormalizedGraphRules,
  labels: LabelSelection,
  targetProjectPath: string,
): GraphRuleReferenceAllow | null {
  return getReferenceRule(rules.allowRefsByLabel, labels, targetProjectPath);
}
