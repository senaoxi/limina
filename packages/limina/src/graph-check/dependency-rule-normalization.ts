import type { ResolvedLiminaConfig } from '#config/runner';
import {
  formatUnknownValue,
  isNonEmptyString,
  isPlainRecord,
} from '#utils/values';
import { createNormalizedDep } from './dependency-rules';
import type { GraphFinding } from './findings';
import { addRuleEntryConfigFinding } from './rule-findings';
import type { GraphRuleDepDeny } from './rule-types';

export interface AddNormalizedDepOptions {
  config: ResolvedLiminaConfig;
  depsByLabel: Map<string, GraphRuleDepDeny[]>;
  entry: unknown;
  index: number;
  label: string;
  findings: GraphFinding[];
}

function getDependencyField(options: AddNormalizedDepOptions): string {
  return `graph.rules.${options.label}.deny.deps[${options.index}]`;
}

function addInvalidDepEntry(
  options: AddNormalizedDepOptions,
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

function addInvalidDepValue(options: {
  field: string;
  normalizedOptions: AddNormalizedDepOptions;
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

function addUnsupportedDepName(options: {
  field: string;
  name: string;
  normalizedOptions: AddNormalizedDepOptions;
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

function storeNormalizedDep(
  options: AddNormalizedDepOptions,
  normalizedDep: GraphRuleDepDeny,
): void {
  const deps = options.depsByLabel.get(options.label) ?? [];
  deps.push(normalizedDep);
  options.depsByLabel.set(options.label, deps);
}

interface ParsedDepEntry {
  name: string;
  reason: string;
}

function parseDepRecord(options: {
  field: string;
  normalizedOptions: AddNormalizedDepOptions;
  record: Record<string, unknown>;
}): ParsedDepEntry | null {
  const nameValue = options.record.name;
  if (!isNonEmptyString(nameValue)) {
    addInvalidDepValue({
      field: `${options.field}.name`,
      normalizedOptions: options.normalizedOptions,
      reason: 'deny.deps name is required and must be a non-empty string.',
      value: nameValue,
    });
    return null;
  }
  const reasonValue = options.record.reason;
  if (!isNonEmptyString(reasonValue)) {
    addInvalidDepValue({
      field: `${options.field}.reason`,
      normalizedOptions: options.normalizedOptions,
      reason: 'deny.deps reason is required and must be a non-empty string.',
      value: reasonValue,
    });
    return null;
  }
  return { name: nameValue.trim(), reason: reasonValue.trim() };
}

function parseDepEntry(
  options: AddNormalizedDepOptions,
  field: string,
): ParsedDepEntry | null {
  if (!isPlainRecord(options.entry)) {
    addInvalidDepEntry(options, field);
    return null;
  }
  return parseDepRecord({
    field,
    normalizedOptions: options,
    record: options.entry,
  });
}

export function addNormalizedDep(options: AddNormalizedDepOptions): void {
  const field = getDependencyField(options);
  const parsed = parseDepEntry(options, field);
  if (parsed === null) {
    return;
  }
  const normalizedDep = createNormalizedDep(parsed.name, parsed.reason);
  if (normalizedDep === null) {
    addUnsupportedDepName({
      field,
      name: parsed.name,
      normalizedOptions: options,
    });
    return;
  }
  storeNormalizedDep(options, normalizedDep);
}
