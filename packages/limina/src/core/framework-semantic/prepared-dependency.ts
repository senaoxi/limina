import type { ResolvedCheckerModuleName } from '#checkers';
import { normalizeAbsolutePathIdentity } from '#utils/path';
import type ts from 'typescript';
import type { ImportRecord } from '../import-analysis/records';
import type { ManagedOutputDeclarationLookup } from '../import-graph/managed-output-provider';
import type { TypeEvidence } from '../type-evidence/cache';
import type {
  FrameworkSemanticKind,
  PreparedDependencyFact,
} from './contracts';
import {
  canonicalTypeEvidenceIdentity,
  cloneTypeEvidence,
  createPreparedFact,
  type ResolvedFrameworkCandidate,
} from './prepared-type-evidence';

export {
  canonicalTypeEvidenceIdentity,
  cloneTypeEvidence,
} from './prepared-type-evidence';

export interface PreparedDependencyMergeFailure {
  kind: 'unsupported';
  reason: string;
  stage: 'source-map-mismatch' | 'toolchain-compatibility';
}

export type PreparedDependencyMergeResult =
  | { facts: PreparedDependencyFact[]; kind: 'supported' }
  | PreparedDependencyMergeFailure;

export type PreparedDirectSourceMergeResult =
  | { kind: 'supported'; records: ImportRecord[] }
  | PreparedDependencyMergeFailure;

function occurrenceIdentity(fact: PreparedDependencyFact): string {
  return JSON.stringify([
    normalizeAbsolutePathIdentity(fact.importRecord.filePath),
    fact.importRecord.locator.sourceStart,
    fact.importRecord.locator.sourceEnd,
  ]);
}

function targetIdentity(target: ResolvedCheckerModuleName | null): unknown {
  return target === null
    ? null
    : [
        normalizeAbsolutePathIdentity(target.resolvedFileName),
        target.resolvedBy,
      ];
}

function semanticIdentity(fact: PreparedDependencyFact): string {
  return JSON.stringify([
    fact.semanticSpecifier,
    fact.resolutionMode,
    targetIdentity(fact.target),
    fact.importRecord.kind,
    canonicalTypeEvidenceIdentity(fact.typeEvidence),
  ]);
}

function findUnsupportedEvidence(
  facts: readonly PreparedDependencyFact[],
): Extract<TypeEvidence, { kind: 'unsupported-checker' }> | undefined {
  return facts
    .map((fact) => fact.typeEvidence)
    .find(
      (
        evidence,
      ): evidence is Extract<TypeEvidence, { kind: 'unsupported-checker' }> =>
        evidence.kind === 'unsupported-checker',
    );
}

function finalizeOccurrences(facts: PreparedDependencyFact[]): void {
  const occurrenceByIdentity = new Map<string, number>();
  facts.sort(
    (left, right) =>
      left.importRecord.locator.sourceStart -
        right.importRecord.locator.sourceStart ||
      left.importRecord.locator.sourceEnd -
        right.importRecord.locator.sourceEnd,
  );
  for (const fact of facts) {
    const identity = JSON.stringify([
      fact.importRecord.kind,
      fact.importRecord.specifier,
    ]);
    const occurrence = occurrenceByIdentity.get(identity) ?? 0;
    occurrenceByIdentity.set(identity, occurrence + 1);
    fact.importRecord.locator.occurrence = occurrence;
  }
}

function groupByIdentity<T>(
  values: readonly T[],
  getIdentity: (value: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const identity = getIdentity(value);
    const group = grouped.get(identity);
    if (group === undefined) grouped.set(identity, [value]);
    else group.push(value);
  }
  return grouped;
}

function directOccurrenceIdentity(record: ImportRecord): string {
  return JSON.stringify([
    normalizeAbsolutePathIdentity(record.filePath),
    record.locator.sourceStart,
    record.locator.sourceEnd,
  ]);
}

function mergeDirectGroup(
  group: readonly ImportRecord[],
): ImportRecord | PreparedDependencyMergeFailure {
  const identities = new Set(
    group.map((record) =>
      JSON.stringify([record.kind, record.specifier, record.domain]),
    ),
  );
  if (identities.size !== 1) {
    return {
      kind: 'unsupported',
      reason:
        'Framework service scripts did not agree on one TypeScript source-directive identity for the same source occurrence.',
      stage: 'source-map-mismatch',
    };
  }
  const first = group[0]!;
  return { ...first, locator: { ...first.locator } };
}

function mergeDirectGroups(
  grouped: ReadonlyMap<string, ImportRecord[]>,
): PreparedDirectSourceMergeResult {
  const records: ImportRecord[] = [];
  for (const group of grouped.values()) {
    const merged = mergeDirectGroup(group);
    if ('stage' in merged) return merged;
    records.push(merged);
  }
  return { kind: 'supported', records };
}

function finalizeDirectOccurrences(records: ImportRecord[]): void {
  records.sort(
    (left, right) =>
      left.locator.sourceStart - right.locator.sourceStart ||
      left.locator.sourceEnd - right.locator.sourceEnd,
  );
  const occurrences = new Map<string, number>();
  for (const record of records) {
    const identity = JSON.stringify([record.kind, record.specifier]);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    record.locator.occurrence = occurrence;
  }
}

export function mergePreparedDirectSourceRecords(
  records: readonly ImportRecord[],
): PreparedDirectSourceMergeResult {
  const result = mergeDirectGroups(
    groupByIdentity(records, directOccurrenceIdentity),
  );
  if (result.kind === 'unsupported') return result;
  finalizeDirectOccurrences(result.records);
  return result;
}

function clonePreparedFact(
  fact: PreparedDependencyFact,
): PreparedDependencyFact {
  return {
    ...fact,
    importRecord: {
      ...fact.importRecord,
      locator: { ...fact.importRecord.locator },
    },
    target: fact.target === null ? null : { ...fact.target },
    typeEvidence: cloneTypeEvidence(fact.typeEvidence),
  };
}

function mergePreparedGroup(options: {
  framework: FrameworkSemanticKind;
  group: readonly PreparedDependencyFact[];
}): PreparedDependencyFact | PreparedDependencyMergeFailure {
  const identities = new Set(options.group.map(semanticIdentity));
  if (identities.size !== 1) {
    return {
      kind: 'unsupported',
      reason: `${options.framework} service scripts did not agree on one semantic target and canonical type evidence for the same source occurrence.`,
      stage: 'source-map-mismatch',
    };
  }
  return clonePreparedFact(options.group[0]!);
}

function mergePreparedGroups(options: {
  framework: FrameworkSemanticKind;
  grouped: ReadonlyMap<string, PreparedDependencyFact[]>;
}): PreparedDependencyMergeResult {
  const facts: PreparedDependencyFact[] = [];
  for (const group of options.grouped.values()) {
    const merged = mergePreparedGroup({ framework: options.framework, group });
    if ('stage' in merged) return merged;
    facts.push(merged);
  }
  return { facts, kind: 'supported' };
}

export function prepareResolvedFrameworkCandidates(options: {
  checkerName: string;
  framework: FrameworkSemanticKind;
  managedOutputLookup?: ManagedOutputDeclarationLookup;
  program?: ts.Program;
  resolved: readonly ResolvedFrameworkCandidate[];
  tsModule: typeof ts;
}): PreparedDependencyMergeResult {
  const facts = options.resolved.map((resolved) =>
    createPreparedFact({
      checkerName: options.checkerName,
      managedOutputLookup: options.managedOutputLookup,
      program: options.program,
      resolved,
      tsModule: options.tsModule,
    }),
  );
  const unsupported = findUnsupportedEvidence(facts);
  if (unsupported !== undefined) {
    return {
      kind: 'unsupported',
      reason: unsupported.reason,
      stage: 'toolchain-compatibility',
    };
  }
  const result = mergePreparedGroups({
    framework: options.framework,
    grouped: groupByIdentity(facts, occurrenceIdentity),
  });
  if (result.kind === 'unsupported') return result;
  finalizeOccurrences(result.facts);
  return result;
}
