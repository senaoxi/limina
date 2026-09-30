import type { ImportRecord as ImportLocationRecord } from '#core/import-analysis/runner';
import { toRelativePath } from '#utils/path';

export { isRelativeSpecifier } from '#utils/module-specifier';
export * from './project-labels';
export * from './project-lookup';
export * from './project-parser';
export type * from './project-types';

export function formatImportRecordLocation(
  rootDirectory: string,
  importRecord: ImportLocationRecord,
): string {
  return importRecord.configurationSource === undefined
    ? `${toRelativePath(rootDirectory, importRecord.filePath)}:${importRecord.line} (kind: ${importRecord.kind})`
    : `${toRelativePath(rootDirectory, importRecord.filePath)} (compiler option: ${toRelativePath(rootDirectory, importRecord.configurationSource.configPath)}#${importRecord.configurationSource.option})`;
}

export {
  collectImportsFromFile,
  createImportAnalysisContext,
  resolveInternalImport,
  type CreateImportAnalysisContextOptions,
  type ImportAnalysisContext,
  type ImportDomain,
  type ImportRecord,
  type ImportRecordKind,
} from '#core/import-analysis/runner';
