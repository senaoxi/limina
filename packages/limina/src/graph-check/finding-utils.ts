import type { ImportRecord } from '#core/import-graph/context';
import type { GraphImportFact } from './findings';

export function createGraphImportFact(
  importRecord: ImportRecord,
): GraphImportFact {
  return {
    filePath: importRecord.filePath,
    kind: importRecord.kind,
    line: importRecord.line,
    specifier: importRecord.specifier,
  };
}

export function getProjectCheckerName(
  projectCheckerNamesByPath: ReadonlyMap<string, string>,
  projectPath: string,
): string | undefined {
  return projectCheckerNamesByPath.get(projectPath);
}
