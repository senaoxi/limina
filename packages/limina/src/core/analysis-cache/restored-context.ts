import { normalizeAbsolutePath } from '#utils/path';
import { freezeNativeData } from '../../domain/analysis/native-evidence-freeze';
import type { ImportRecord } from '../import-analysis/records';
import type { TypeScriptSemanticDependencyContext } from '../typescript-semantic/contracts';
import type { NativeDependencyFact } from '../typescript-semantic/dependency-fact';
import { createTypeScriptResolutionIdentity } from '../typescript-semantic/identity';
import type { ImporterRecord, NativeContextRecord } from './contracts';
import { occurrenceKey } from './semantic-state';
export function restoredDependencyContext(
  identity: string,
  context: NativeContextRecord,
  importers: Record<string, ImporterRecord>,
): TypeScriptSemanticDependencyContext {
  const evidence = restoredNativeEvidence(context);
  const restoredIdentity = restoredContextIdentity(identity, evidence);
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
    return restoredFact(fact, record, restoredIdentity);
  };
  return {
    identity: restoredIdentity,
    nativeEvidence: evidence,
    nativeInventory:
      context.native === undefined
        ? undefined
        : freezeNativeData(context.native.inventory),
    getTypeEnvironmentEntries: () => structuredClone(context.typeEntries),
    getContributionFileNames: () => Object.keys(context.sources),
    hasSourceFile: (file) =>
      Object.hasOwn(context.sources, normalizeAbsolutePath(file)),
    getImportRecords: (file) =>
      structuredClone(importerFor(file)?.occurrences ?? []),
    getDependencyFact: (record) => structuredClone(factFor(record)),
    resolveImportRecord: (record) =>
      structuredClone(factFor(record).resolution),
  };
}

function restoredFact(
  fact: NativeDependencyFact,
  record: ImportRecord,
  identity: string,
): NativeDependencyFact {
  // Validated Native facts retain their observed context and resolution IDs.
  // A cache hit neither recollects nor upgrades the original qualification.
  if (fact.nativeEvidence !== undefined) return fact;
  return {
    ...fact,
    resolution: {
      ...fact.resolution,
      identity: createTypeScriptResolutionIdentity({
        contextIdentity: identity,
        importRecord: record,
        redirectedReferenceIdentity:
          fact.resolution.redirectedReferenceIdentity,
        resolutionMode: fact.resolution.resolutionMode,
      }),
    },
  };
}

function restoredNativeEvidence(context: NativeContextRecord) {
  return context.native === undefined
    ? undefined
    : freezeNativeData(context.native.snapshot);
}
function restoredContextIdentity(
  identity: string,
  evidence: ReturnType<typeof restoredNativeEvidence>,
): string {
  return evidence === undefined ? identity : evidence.contexts[0]!.id;
}
