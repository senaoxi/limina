import type ts from 'typescript';
import type {
  ImportRecord,
  ImportRecordKind,
} from '../import-analysis/records';

const MODULE_KINDS = new Set<ImportRecordKind>([
  'commonjs',
  'dynamic',
  'export',
  'import-equals',
  'import-type',
  'jsdoc-import',
  'require-resolve',
  'static',
]);

export function isModuleImportRecord(importRecord: ImportRecord): boolean {
  return MODULE_KINDS.has(importRecord.kind);
}

export function createImportRecordIdentity(importRecord: ImportRecord): string {
  return JSON.stringify({
    containingFile: importRecord.filePath,
    kind: importRecord.kind,
    locator: importRecord.locator,
    specifier: importRecord.specifier,
  });
}

function matchesRange(
  node: ts.StringLiteralLike,
  sourceFile: ts.SourceFile,
  importRecord: ImportRecord,
): boolean {
  return (
    node.getStart(sourceFile) === importRecord.locator.sourceStart &&
    node.getEnd() === importRecord.locator.sourceEnd
  );
}

function matchesNode(options: {
  importRecord: ImportRecord;
  node: ts.Node;
  sourceFile: ts.SourceFile;
  tsModule: typeof ts;
}): options is typeof options & { node: ts.StringLiteralLike } {
  if (!options.tsModule.isStringLiteralLike(options.node)) return false;
  if (options.node.text !== options.importRecord.specifier) return false;
  return matchesRange(options.node, options.sourceFile, options.importRecord);
}

export function findImportRecordLiteral(options: {
  importRecord: ImportRecord;
  sourceFile: ts.SourceFile;
  tsModule: typeof ts;
}): ts.StringLiteralLike | null {
  let matched: ts.StringLiteralLike | null = null;
  const visit = (node: ts.Node): void => {
    if (matched !== null) return;
    const candidate = { ...options, node };
    if (matchesNode(candidate)) {
      matched = candidate.node;
      return;
    }
    options.tsModule.forEachChild(node, visit);
  };
  visit(options.sourceFile);
  return matched;
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
      matchesRange(options.literal, options.sourceFile, record),
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
