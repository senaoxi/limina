import type ts from 'typescript';
import type { ImportRecord } from '../import-analysis/records';
import { findImportRecordLiteral } from './import-record';

// Governance qualification is independent of the compiler's loading decision.
export function requestEligibility(
  file: ts.SourceFile,
  record: ImportRecord,
  compiler: typeof ts,
): { governance: boolean; expansion: boolean } {
  const isIgnored = [
    isDocumentationOnly(file, record),
    record.kind === 'require-resolve',
    isInvalidAmbientImport(file, record, compiler),
  ].some(Boolean);
  return {
    governance: !isIgnored,
    expansion: !isIgnored && record.kind !== 'module-augmentation',
  };
}
function isDocumentationOnly(
  file: ts.SourceFile,
  record: ImportRecord,
): boolean {
  return (
    record.kind === 'environment-pragma' ||
    [record.kind === 'jsdoc-import', !/\.[cm]?jsx?$/.test(file.fileName)].every(
      Boolean,
    )
  );
}
function isRelativeAmbientCandidate(
  file: ts.SourceFile,
  record: ImportRecord,
  compiler: typeof ts,
): boolean {
  return [
    !compiler.isExternalModule(file),
    ['static', 'export', 'import-equals'].includes(record.kind),
    /^\.\.?\//.test(record.specifier),
  ].every(Boolean);
}
function isStringModule(node: ts.Node, compiler: typeof ts): boolean {
  return (
    compiler.isModuleDeclaration(node) && compiler.isStringLiteral(node.name)
  );
}
function hasAmbientParent(
  node: ts.Node | undefined,
  compiler: typeof ts,
): boolean {
  for (let parent = node; parent !== undefined; parent = parent.parent)
    if (isStringModule(parent, compiler)) return true;
  return false;
}
function isInvalidAmbientImport(
  file: ts.SourceFile,
  record: ImportRecord,
  compiler: typeof ts,
): boolean {
  if (!isRelativeAmbientCandidate(file, record, compiler)) return false;
  const literal = findImportRecordLiteral({
    importRecord: record,
    sourceFile: file,
    tsModule: compiler,
  });
  return hasAmbientParent(literal?.parent, compiler);
}
function hasDeclareModifier(
  node: ts.ModuleDeclaration,
  compiler: typeof ts,
): boolean {
  return (
    node.modifiers?.some(
      (modifier) => modifier.kind === compiler.SyntaxKind.DeclareKeyword,
    ) ?? false
  );
}
function isDeclaredModule(
  file: ts.SourceFile,
  node: ts.ModuleDeclaration,
  compiler: typeof ts,
): boolean {
  return file.isDeclarationFile || hasDeclareModifier(node, compiler);
}
function augmentationName(
  file: ts.SourceFile,
  node: ts.Statement,
  compiler: typeof ts,
): ts.StringLiteral | undefined {
  if (!compiler.isModuleDeclaration(node)) return undefined;
  const isQualified = [
    compiler.isStringLiteral(node.name),
    node.body !== undefined,
    isDeclaredModule(file, node, compiler),
  ].every(Boolean);
  return isQualified ? (node.name as ts.StringLiteral) : undefined;
}
function augmentationRecord(
  file: ts.SourceFile,
  name: ts.StringLiteral,
  occurrence: number,
): ImportRecord {
  return {
    domain: 'typescript',
    filePath: file.fileName,
    kind: 'module-augmentation',
    specifier: name.text,
    line: file.getLineAndCharacterOfPosition(name.getStart(file)).line + 1,
    locator: {
      sourceStart: name.getStart(file),
      sourceEnd: name.end,
      occurrence,
    },
  };
}
// Only a potential augmentation until the consumer's module shape is bound.
export function potentialAugmentations(
  file: ts.SourceFile,
  compiler: typeof ts,
): ImportRecord[] {
  const records: ImportRecord[] = [];
  for (const statement of file.statements) {
    const name = augmentationName(file, statement, compiler);
    if (name === undefined) continue;
    records.push(
      augmentationRecord(
        file,
        name,
        records.filter((record) => record.specifier === name.text).length,
      ),
    );
  }
  return records;
}
