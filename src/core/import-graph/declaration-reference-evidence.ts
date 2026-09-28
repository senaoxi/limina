import type { ImportRecord } from '#core/import-analysis/runner';

export function shouldInferDeclarationReferenceFromImportRecord(
  importRecord: ImportRecord,
): boolean {
  return importRecord.kind !== 'require-resolve';
}
