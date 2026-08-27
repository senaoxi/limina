import type { ImportRecord as ImportLocationRecord } from '#core/import-analysis/runner';
import { toRelativePath } from '#utils/path';

export { isRelativeSpecifier } from '#utils/module-specifier';
export * from './project-labels';
export * from './project-lookup';
export * from './project-parser';
export type * from './project-types';

export function formatImportRecordLocation(
  rootDir: string,
  importRecord: ImportLocationRecord,
): string {
  return `${toRelativePath(rootDir, importRecord.filePath)}:${importRecord.line} (kind: ${importRecord.kind})`;
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
