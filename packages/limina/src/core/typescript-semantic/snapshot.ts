import { normalizeAbsolutePath } from '#utils/path';
import type { ImportRecord } from '../import-analysis/records';
import type {
  TypeScriptSemanticDependencyContext,
  TypeScriptSemanticResolution,
} from './contracts';
import type { NativeDependencyFact } from './dependency-fact';
import { createImportRecordIdentity } from './import-record';

function cloneImportRecord(record: ImportRecord): ImportRecord {
  return structuredClone(record);
}

function cloneResolution(
  resolution: TypeScriptSemanticResolution,
): TypeScriptSemanticResolution {
  return {
    ...resolution,
    target:
      resolution.target === null ? null : structuredClone(resolution.target),
  };
}

function captureSourceFile(options: {
  context: TypeScriptSemanticDependencyContext;
  fileName: string;
  facts: Map<string, NativeDependencyFact>;
  recordsByFileName: Map<string, readonly ImportRecord[]>;
  resolutionsByImportRecord: Map<string, TypeScriptSemanticResolution>;
  sourceFileNames: Set<string>;
}): void {
  const normalized = normalizeAbsolutePath(options.fileName);
  if (!options.context.hasSourceFile(normalized)) return;
  options.sourceFileNames.add(normalized);
  const records = options.context
    .getImportRecords(normalized)
    .map(cloneImportRecord);
  options.recordsByFileName.set(normalized, records);
  for (const record of records) {
    options.facts.set(
      createImportRecordIdentity(record),
      capturedFact(options.context, record),
    );
    options.resolutionsByImportRecord.set(
      createImportRecordIdentity(record),
      cloneResolution(options.context.resolveImportRecord(record)),
    );
  }
}

export function createTypeScriptSemanticDependencySnapshot(options: {
  context: TypeScriptSemanticDependencyContext;
  fileNames: readonly string[];
}): TypeScriptSemanticDependencyContext {
  const facts = new Map<string, NativeDependencyFact>();
  const recordsByFileName = new Map<string, readonly ImportRecord[]>();
  const resolutionsByImportRecord = new Map<
    string,
    TypeScriptSemanticResolution
  >();
  const sourceFileNames = new Set<string>();

  const contributionFiles = contributionFileNames(options.context);
  const files = new Set([...options.fileNames, ...contributionFiles]);
  for (const fileName of files) {
    captureSourceFile({
      context: options.context,
      facts,
      fileName,
      recordsByFileName,
      resolutionsByImportRecord,
      sourceFileNames,
    });
  }

  return {
    nativeEvidence: options.context.nativeEvidence,
    identity: options.context.identity,
    getTypeEnvironmentEntries: (() => {
      const entries = options.context.getTypeEnvironmentEntries?.() ?? [];
      return () => structuredClone(entries);
    })(),
    getContributionFileNames: () => [...sourceFileNames],
    getDependencyFact(record) {
      const fact = facts.get(createImportRecordIdentity(record));
      if (fact === undefined)
        throw new Error(
          'Native dependency fact is absent from the semantic snapshot.',
        );
      return structuredClone(fact);
    },
    getImportRecords(fileName) {
      return (recordsByFileName.get(normalizeAbsolutePath(fileName)) ?? []).map(
        cloneImportRecord,
      );
    },
    hasSourceFile(fileName) {
      return sourceFileNames.has(normalizeAbsolutePath(fileName));
    },
    resolveImportRecord(importRecord) {
      const resolution = resolutionsByImportRecord.get(
        createImportRecordIdentity(importRecord),
      );
      if (resolution === undefined) {
        throw new Error(
          'TypeScript semantic snapshot does not contain the requested import occurrence.',
        );
      }
      return cloneResolution(resolution);
    },
  };
}

function capturedFact(
  context: TypeScriptSemanticDependencyContext,
  record: ImportRecord,
): NativeDependencyFact {
  const facts = collectedFacts(context);
  const fact =
    facts?.get(createImportRecordIdentity(record)) ??
    context.getDependencyFact(record);
  return structuredClone(fact);
}

function collectedFacts(
  context: TypeScriptSemanticDependencyContext,
): ReadonlyMap<string, NativeDependencyFact> | undefined {
  return context.getCollectedDependencyFacts?.();
}

function contributionFileNames(
  context: TypeScriptSemanticDependencyContext,
): readonly string[] {
  return context.getContributionFileNames?.() ?? [];
}
