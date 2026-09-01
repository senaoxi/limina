import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import type { ImportRecord } from '../import-analysis/records';
import {
  findEffectiveJsxImportSourceRecord,
  findImportRecordByLiteral,
  findImportRecordLiteral,
  isModuleImportRecord,
} from './import-record';

export function createSyntheticImportRecord(options: {
  containingFile: string;
  literal: ts.StringLiteralLike;
}): ImportRecord {
  return {
    domain: 'typescript',
    filePath: normalizeAbsolutePath(options.containingFile),
    kind: 'static',
    line: 0,
    locator: {
      occurrence: -1,
      sourceEnd: options.literal.end,
      sourceStart: options.literal.pos,
    },
    specifier: options.literal.text,
  };
}

export function findSemanticModuleRecord(options: {
  literal: ts.StringLiteralLike;
  records: readonly ImportRecord[];
  sourceFile: ts.SourceFile;
}): ImportRecord | undefined {
  const exact = findImportRecordByLiteral(options);
  if (exact !== undefined) return exact;
  return findJsxRecord(options.literal, options.records);
}

function findJsxRecord(
  literal: ts.StringLiteralLike,
  records: readonly ImportRecord[],
): ImportRecord | undefined {
  const record = findEffectiveJsxImportSourceRecord(records);
  if (record === undefined) return undefined;
  const prefix = `${record.specifier}/jsx-`;
  return literal.text.startsWith(prefix) ? record : undefined;
}

export function getStandaloneModuleLocation(options: {
  getSourceFile(fileName: string): ts.SourceFile | undefined;
  importRecord: ImportRecord;
  tsModule: typeof ts;
}): { literal: ts.StringLiteralLike; sourceFile: ts.SourceFile } | null {
  const sourceFile = getModuleSourceFile(options);
  if (sourceFile === undefined) return null;
  const literal = findImportRecordLiteral({
    importRecord: options.importRecord,
    sourceFile,
    tsModule: options.tsModule,
  });
  if (literal === null) return null;
  return { literal, sourceFile };
}

function getModuleSourceFile(options: {
  getSourceFile(fileName: string): ts.SourceFile | undefined;
  importRecord: ImportRecord;
}): ts.SourceFile | undefined {
  if (!isModuleImportRecord(options.importRecord)) return undefined;
  return options.getSourceFile(options.importRecord.filePath);
}
