import { normalizeAbsolutePath } from '#utils/path';
import type { ImportRecord } from '../import-analysis/records';
import type { TypeScriptSemanticDependencyContext } from '../typescript-semantic/contracts';
import { createTypeScriptResolutionIdentity } from '../typescript-semantic/identity';
import type { ImporterRecord, NativeContextRecord } from './contracts';
import { occurrenceKey } from './semantic-state';
export function restoredDependencyContext(
  identity: string,
  context: NativeContextRecord,
  importers: Record<string, ImporterRecord>,
): TypeScriptSemanticDependencyContext {
  const importerFor = (file: string) => {
    const id = context.sources[normalizeAbsolutePath(file)];
    return id == null ? undefined : importers[id];
  };
  const factFor = (record: ImportRecord) => {
    const fact = importerFor(record.filePath)?.facts[occurrenceKey(record)];
    if (fact === undefined)
      throw new Error(
        'Restored native context lacks the requested occurrence.',
      );
    const resolution = {
      ...fact.resolution,
      identity: createTypeScriptResolutionIdentity({
        contextIdentity: identity,
        importRecord: record,
        redirectedReferenceIdentity:
          fact.resolution.redirectedReferenceIdentity,
        resolutionMode: fact.resolution.resolutionMode,
      }),
    };
    return { ...fact, resolution };
  };
  return {
    identity,
    hasSourceFile: (file) =>
      Object.hasOwn(context.sources, normalizeAbsolutePath(file)),
    getImportRecords: (file) =>
      structuredClone(importerFor(file)?.occurrences ?? []),
    getDependencyFact: (record) => structuredClone(factFor(record)),
    resolveImportRecord: (record) =>
      structuredClone(factFor(record).resolution),
  };
}
