import { normalizeAbsolutePath } from '#utils/path';
import type { ImportRecord } from '../import-analysis/records';
import type {
  TypeScriptSemanticContext,
  TypeScriptSemanticDependencyContext,
  TypeScriptSemanticResolution,
} from './contracts';
import { createImportRecordIdentity } from './import-record';

function cloneImportRecord(record: ImportRecord): ImportRecord {
  return { ...record, locator: { ...record.locator } };
}

function cloneResolution(
  resolution: TypeScriptSemanticResolution,
): TypeScriptSemanticResolution {
  return {
    ...resolution,
    target: resolution.target === null ? null : { ...resolution.target },
  };
}

function captureSourceFile(options: {
  context: TypeScriptSemanticContext;
  fileName: string;
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
    options.resolutionsByImportRecord.set(
      createImportRecordIdentity(record),
      cloneResolution(options.context.resolveImportRecord(record)),
    );
  }
}

export function createTypeScriptSemanticDependencySnapshot(options: {
  context: TypeScriptSemanticContext;
  fileNames: readonly string[];
}): TypeScriptSemanticDependencyContext {
  const recordsByFileName = new Map<string, readonly ImportRecord[]>();
  const resolutionsByImportRecord = new Map<
    string,
    TypeScriptSemanticResolution
  >();
  const sourceFileNames = new Set<string>();

  for (const fileName of options.fileNames) {
    captureSourceFile({
      context: options.context,
      fileName,
      recordsByFileName,
      resolutionsByImportRecord,
      sourceFileNames,
    });
  }

  return {
    identity: options.context.identity,
    getImportRecords(fileName) {
      return recordsByFileName.get(normalizeAbsolutePath(fileName)) ?? [];
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
