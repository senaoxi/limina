import { normalizeAbsolutePath } from '#utils/path';
import { freezeNativeData } from '../../domain/analysis/native-evidence-freeze';
import type { ImportRecord } from '../import-analysis/records';
import type { TypeScriptSemanticDependencyContext } from '../typescript-semantic/contracts';
import type { NativeDependencyFact } from '../typescript-semantic/dependency-fact';
import { createTypeScriptResolutionIdentity } from '../typescript-semantic/identity';
import { isLiveNativeInventory } from '../typescript-semantic/native-context-inventory';
import { nativeFileRequest } from '../typescript-semantic/native-file-requests';
import type { ImporterRecord, NativeContextRecord } from './contracts';
import { retainContextExecutionInputs } from './execution-inputs';
import type { NativeAnalysisCache } from './native-cache';
import { occurrenceKey } from './semantic-state';

const qualifiedRestorations =
  new WeakSet<TypeScriptSemanticDependencyContext>();

/**
 * Called after the current context has bound its compiler inventory and execution reads.
 */
export function retainQualifiedNativeContext(
  context: TypeScriptSemanticDependencyContext,
): void {
  if (
    context.nativeInventory !== undefined &&
    context.nativeEvidence !== undefined
  )
    qualifiedRestorations.add(context);
}

export function hasQualifiedNativeContext(
  context: TypeScriptSemanticDependencyContext,
): boolean {
  return (
    isLiveNativeInventory(context.nativeInventory) ||
    qualifiedRestorations.has(context)
  );
}

export function restoredDependencyContext(
  identity: string,
  context: NativeContextRecord,
  importers: Record<string, ImporterRecord>,
  cache: NativeAnalysisCache,
): TypeScriptSemanticDependencyContext {
  const facts = storedContextFacts(identity, context, importers);
  restoreExecutionInputs(context, facts.nativeEvidence, cache);
  if (context.complete) retainQualifiedNativeContext(facts);
  return facts;
}

/**
 * A reader for already bound records. Its caller qualifies any reused source.
 */
export function storedContextFacts(
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
    getNativeFileRequests: (file) =>
      (importerFor(file)?.occurrences ?? []).map((record) =>
        nativeFileRequest(record, factFor(record)),
      ),
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

function restoreExecutionInputs(
  context: NativeContextRecord,
  evidence: ReturnType<typeof restoredNativeEvidence>,
  cache: NativeAnalysisCache,
): void {
  if (context.native === undefined) return;
  const inputs = cache.epoch.selectRecords(context.native.discovery);
  if (inputs === undefined)
    throw new Error('Restored execution evidence is no longer current.');
  retainContextExecutionInputs(evidence, context.project.configPath, inputs, {
    cache,
    ids: context.queryIds,
    environment: context.environment.dependencies,
  });
}
