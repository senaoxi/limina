import type ts from 'typescript';
import type {
  ImportRecord,
  ImportRecordKind,
} from '../import-analysis/records';
import { findSourceFileLiterals } from './source-file-literals';

const MODULE_KINDS = new Set<ImportRecordKind>([
  'commonjs',
  'dynamic',
  'export',
  'import-equals',
  'import-type',
  'jsdoc-import',
  'require-resolve',
  'static',
  'module-augmentation',
]);

export function isModuleImportRecord(importRecord: ImportRecord): boolean {
  return MODULE_KINDS.has(importRecord.kind);
}

export function createImportRecordIdentity(importRecord: ImportRecord): string {
  return JSON.stringify({
    containingFile: importRecord.filePath,
    compilerRequest: importRecord.compilerRequest,
    kind: importRecord.kind,
    locator: [
      importRecord.locator.occurrence,
      importRecord.locator.sourceStart,
      importRecord.locator.sourceEnd,
    ],
    specifier: importRecord.specifier,
  });
}

function isMatchesRange(
  node: ts.StringLiteralLike,
  sourceFile: ts.SourceFile,
  importRecord: ImportRecord,
): boolean {
  return (
    node.getStart(sourceFile) === importRecord.locator.sourceStart &&
    node.getEnd() === importRecord.locator.sourceEnd
  );
}

function isMatchesNode(options: {
  importRecord: ImportRecord;
  node: ts.Node;
  sourceFile: ts.SourceFile;
  tsModule: typeof ts;
}): options is typeof options & { node: ts.StringLiteralLike } {
  return (
    options.tsModule.isStringLiteralLike(options.node) &&
    options.node.text === options.importRecord.specifier &&
    isMatchesRange(options.node, options.sourceFile, options.importRecord)
  );
}

export function findImportRecordLiteral(options: {
  importRecord: ImportRecord;
  sourceFile: ts.SourceFile;
  tsModule: typeof ts;
}): ts.StringLiteralLike | null {
  const literals = findSourceFileLiterals({
    ...options,
    matches: (node) => isMatchesNode({ ...options, node }),
  });
  return literals.length === 1 ? literals[0]! : null;
}

export function findImportRecordByLiteral(options: {
  literal: ts.StringLiteralLike;
  records: readonly ImportRecord[];
  sourceFile: ts.SourceFile;
}): ImportRecord | undefined {
  return options.records.find(
    (record) =>
      isModuleImportRecord(record) &&
      record.specifier === options.literal.text &&
      isMatchesRange(options.literal, options.sourceFile, record),
  );
}

export function findDirectiveRecord(options: {
  kind: 'triple-slash-path' | 'triple-slash-types';
  occurrence: number;
  records: readonly ImportRecord[];
  specifier: string;
}): ImportRecord | undefined {
  return options.records.filter(
    (record) =>
      record.kind === options.kind && record.specifier === options.specifier,
  )[options.occurrence];
}

export function findEffectiveJsxImportSourceRecord(
  records: readonly ImportRecord[],
): ImportRecord | undefined {
  return records.findLast((record) => record.kind === 'jsx-import-source');
}

/**
 * One parsed-source batch; never retained across AST mutation or contexts.
 */
export function findImportRecordLiterals(options: {
  records: readonly ImportRecord[];
  sourceFile: ts.SourceFile;
  tsModule: typeof ts;
}): Map<ImportRecord, ts.StringLiteralLike | null> {
  if (options.records.length === 0) return new Map();
  const indexed = new Map<string, ts.StringLiteralLike | null>();
  const literals = findSourceFileLiterals({ ...options, matches: () => true });
  for (const literal of literals) {
    const key = literalKey(
      literal.text,
      literal.getStart(options.sourceFile),
      literal.end,
    );
    indexed.set(key, indexed.has(key) ? null : literal);
  }
  return new Map(
    options.records.map((record) => [
      record,
      indexed.get(
        literalKey(
          record.specifier,
          record.locator.sourceStart,
          record.locator.sourceEnd,
        ),
      ) ?? null,
    ]),
  );
}
function literalKey(text: string, start: number, end: number): string {
  return JSON.stringify([text, start, end]);
}
