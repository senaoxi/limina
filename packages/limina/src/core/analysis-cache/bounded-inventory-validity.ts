import type { NativeRequest } from '../../domain/analysis/native-evidence';
import type { ImportRecord } from '../import-analysis/records';
import type {
  ImporterRecord,
  NativeContextRecord,
  ProjectRecord,
} from './contracts';
import { occurrenceKey } from './semantic-state';

interface Inventory {
  record: NativeContextRecord;
  importers: Record<string, ImporterRecord>;
  project: ProjectRecord | undefined;
  contextId: string;
}

/**
 * Join both ways: an empty retained projection must not erase compiler work.
 */
export function hasCompleteBoundedInventory(input: Inventory): boolean {
  if (input.project === undefined) return false;
  const members = new Set(input.project.members);
  const sources = Object.keys(input.record.sources);
  const observed = input.record.native!.snapshot.requests.filter(hasOccurrence);
  const byFile = Map.groupBy(
    observed,
    (request) => request.sourceFile!.lexicalPath,
  );
  return [
    members.size === input.project.members.length,
    sources.length === members.size,
    sources.every((file) => members.has(file)),
    byFile.keys().every((file) => members.has(file)),
    sources.every((file) =>
      hasBoundImporter(input, file, byFile.get(file) ?? []),
    ),
  ].every(Boolean);
}

function hasBoundImporter(
  input: Inventory,
  file: string,
  requests: NativeRequest[],
): boolean {
  const id = input.record.sources[file];
  const importer = id === null ? undefined : input.importers[id];
  if (importer === undefined) return false;
  return [
    importer.contextId === input.contextId,
    importer.filePath === file,
    hasCompleteOccurrences(importer, requests),
  ].every(Boolean);
}

function hasOccurrence(request: NativeRequest): boolean {
  // Config/environment requests without a SourceFile have no ImportRecord.
  // Synthetic module imports do: their compiler entry has a negative position.
  return (
    request.sourceFile !== null &&
    [
      request.entry.kind === 'source',
      ['module', 'implicit'].includes(request.channel),
    ].some(Boolean)
  );
}

function hasCompleteOccurrences(
  importer: ImporterRecord,
  requests: NativeRequest[],
): boolean {
  const remaining = new Map(requests.map((request) => [request.id, request]));
  const keys = importer.occurrences.map(occurrenceKey);
  const isUnique = [
    remaining.size === requests.length,
    new Set(keys).size === keys.length,
    Object.keys(importer.facts).length === keys.length,
  ].every(Boolean);
  return isUnique && hasAllOccurrences(importer, remaining);
}

function hasAllOccurrences(
  importer: ImporterRecord,
  remaining: Map<string, NativeRequest>,
): boolean {
  const hasMatched = importer.occurrences.every((record) =>
    hasConsumedOccurrence(importer, remaining, record),
  );
  return hasMatched && remaining.size === 0;
}

function hasConsumedOccurrence(
  importer: ImporterRecord,
  remaining: Map<string, NativeRequest>,
  record: ImportRecord,
): boolean {
  const id = occurrenceRequestId(importer, record);
  return id !== undefined && hasConsumedRequest(remaining, id, record);
}

function hasConsumedRequest(
  remaining: Map<string, NativeRequest>,
  id: string,
  record: ImportRecord,
): boolean {
  const request = remaining.get(id);
  if (request === undefined) return false;
  remaining.delete(id);
  return [
    record.domain === 'typescript',
    record.filePath === request.sourceFile!.lexicalPath,
    record.specifier === request.specifier,
    hasMatchingEntry(record, request),
  ].every(Boolean);
}

function hasMatchingEntry(
  record: ImportRecord,
  request: NativeRequest,
): boolean {
  if (request.entry.kind !== 'source') return record.locator.sourceStart < 0;
  return request.channel === 'module'
    ? record.locator.sourceStart >= request.entry.position
    : record.locator.sourceStart === request.entry.position;
}

function occurrenceRequestId(
  importer: ImporterRecord,
  record: ImportRecord,
): string | undefined {
  return importer.facts[occurrenceKey(record)]?.nativeEvidence?.requestId;
}
