import type { ResolvedLiminaConfig } from '#config/runner';
import {
  formatUnknownValue,
  isNonEmptyString,
  isPlainRecord,
} from '#utils/values';
import { createNormalizedDependency } from './dependency-rules';
import type { GraphFinding } from './findings';
import { addRuleEntryConfigFinding } from './rule-findings';
import type { GraphRuleDependencyDeny } from './rule-types';

export interface AddNormalizedDependencyOptions {
  config: ResolvedLiminaConfig;
  depsByLabel: Map<string, GraphRuleDependencyDeny[]>;
  entry: unknown;
  index: number;
  label: string;
  findings: GraphFinding[];
}

function getDependencyField(options: AddNormalizedDependencyOptions): string {
  return `graph.rules.${options.label}.deny.deps[${options.index}]`;
}

function addInvalidDependencyEntry(
  options: AddNormalizedDependencyOptions,
  field: string,
): void {
  const reason =
    'deny.deps entries must be objects with non-empty name and reason fields.';
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

function addInvalidDependencyValue(options: {
  field: string;
  normalizedOptions: AddNormalizedDependencyOptions;
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

function addUnsupportedDependencyName(options: {
  field: string;
  name: string;
  normalizedOptions: AddNormalizedDependencyOptions;
}): void {
  const reason =
    'deny.deps name must be a package root, a package.json imports specifier such as "#internal/*", or a Node builtin such as "fs", "node:fs", or "node:*".';
  addRuleEntryConfigFinding({
    config: options.normalizedOptions.config,
    details: [
      `  field: ${options.field}.name`,
      `  name: ${options.name}`,
      `  reason: ${reason}`,
    ],
    findings: options.normalizedOptions.findings,
    reason,
  });
}

function storeNormalizedDependency(
  options: AddNormalizedDependencyOptions,
  normalizedDependency: GraphRuleDependencyDeny,
): void {
  const dependencies = options.depsByLabel.get(options.label) ?? [];
  dependencies.push(normalizedDependency);
  options.depsByLabel.set(options.label, dependencies);
}

interface ParsedDependencyEntry {
  name: string;
  reason: string;
}

function parseDependencyRecord(options: {
  field: string;
  normalizedOptions: AddNormalizedDependencyOptions;
  record: Record<string, unknown>;
}): ParsedDependencyEntry | null {
  const nameValue = options.record.name;
  if (!isNonEmptyString(nameValue)) {
    addInvalidDependencyValue({
      field: `${options.field}.name`,
      normalizedOptions: options.normalizedOptions,
      reason: 'deny.deps name is required and must be a non-empty string.',
      value: nameValue,
    });
    return null;
  }
  const reasonValue = options.record.reason;
  if (!isNonEmptyString(reasonValue)) {
    addInvalidDependencyValue({
      field: `${options.field}.reason`,
      normalizedOptions: options.normalizedOptions,
      reason: 'deny.deps reason is required and must be a non-empty string.',
      value: reasonValue,
    });
    return null;
  }
  return { name: nameValue.trim(), reason: reasonValue.trim() };
}

function parseDependencyEntry(
  options: AddNormalizedDependencyOptions,
  field: string,
): ParsedDependencyEntry | null {
  if (!isPlainRecord(options.entry)) {
    addInvalidDependencyEntry(options, field);
    return null;
  }
  return parseDependencyRecord({
    field,
    normalizedOptions: options,
    record: options.entry,
  });
}

export function addNormalizedDependency(
  options: AddNormalizedDependencyOptions,
): void {
  const field = getDependencyField(options);
  const parsed = parseDependencyEntry(options, field);
  if (parsed === null) {
    return;
  }
  const normalizedDependency = createNormalizedDependency(
    parsed.name,
    parsed.reason,
  );
  if (normalizedDependency === null) {
    addUnsupportedDependencyName({
      field,
      name: parsed.name,
      normalizedOptions: options,
    });
    return;
  }
  storeNormalizedDependency(options, normalizedDependency);
}
