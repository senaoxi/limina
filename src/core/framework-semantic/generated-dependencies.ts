import type ts from 'typescript';
import type { ImportRecord } from '../import-analysis/records';
import { collectTypeScriptSourceFileImports } from '../import-analysis/typescript-imports';

export interface GeneratedSemanticDependency {
  generatedFilePath: string;
  literal: ts.StringLiteralLike | null;
  record: ImportRecord;
  sourceFile: ts.SourceFile;
}

export function rangeIdentity(start: number, end: number): string {
  return JSON.stringify([start, end]);
}

export function getRecordRangeIdentities(
  record: ImportRecord,
): readonly string[] {
  const { sourceEnd, sourceStart } = record.locator;
  return [
    rangeIdentity(sourceStart, sourceEnd),
    rangeIdentity(sourceStart + 1, sourceEnd - 1),
  ];
}

export function findLiteralAtRecord(options: {
  record: ImportRecord;
  sourceFile: ts.SourceFile;
  tsModule: typeof ts;
}): ts.StringLiteralLike | null {
  let result: ts.StringLiteralLike | null = null;
  const visit = (node: ts.Node): void => {
    if (
      options.tsModule.isStringLiteralLike(node) &&
      hasRecordRange({ ...options, node })
    ) {
      result = node;
      return;
    }
    options.tsModule.forEachChild(node, visit);
  };
  visit(options.sourceFile);
  return result;
}

function hasRecordRange(options: {
  node: ts.StringLiteralLike;
  record: ImportRecord;
  sourceFile: ts.SourceFile;
}): boolean {
  return (
    options.node.getStart(options.sourceFile) ===
      options.record.locator.sourceStart &&
    options.node.getEnd() === options.record.locator.sourceEnd
  );
}

export function enumerateGeneratedSemanticDependencies(options: {
  generatedFilePath: string;
  sourceFile: ts.SourceFile;
  tsModule: typeof ts;
}): GeneratedSemanticDependency[] {
  return collectTypeScriptSourceFileImports({
    filePath: options.generatedFilePath,
    sourceFile: options.sourceFile,
    tsModule: options.tsModule,
  }).map((record) => ({
    generatedFilePath: options.generatedFilePath,
    literal: findLiteralAtRecord({ ...options, record }),
    record,
    sourceFile: options.sourceFile,
  }));
}

export function recordMatchesMappedRanges(options: {
  mappedRanges: ReadonlySet<string>;
  record: ImportRecord;
}): boolean {
  return getRecordRangeIdentities(options.record).some((identity) =>
    options.mappedRanges.has(identity),
  );
}
