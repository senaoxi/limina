import ts from 'typescript';
import {
  buildLineStarts,
  type CollectedImportRecord,
  createImportRecord,
  type ImportRecordKind,
} from './records';
import { prepareRequireBindings } from './require-binding-aliases';
import {
  type PreparedRequireBindings,
  resolveRequireBinding,
} from './require-binding-scope';

export interface RequireImportCollectionOptions {
  filePath: string;
  lineOffset?: number;
  scriptKind: ts.ScriptKind;
  sourceOffset?: number;
  sourceText: string;
}

function isUsableRequireBinding(
  bindings: PreparedRequireBindings,
  identifier: ts.Identifier,
): boolean {
  const binding = resolveRequireBinding(
    bindings.graph,
    identifier,
    identifier.text,
  );
  if (binding === undefined) return identifier.text === 'require';
  if (binding.kind !== 'require-alias') return false;
  return !bindings.reassigned.has(binding);
}

function isRequireResolveAccess(
  expression: ts.Expression,
): expression is ts.PropertyAccessExpression & {
  expression: ts.Identifier;
} {
  if (!isPlainPropertyAccess(expression)) return false;
  if (expression.name.text !== 'resolve') return false;
  return ts.isIdentifier(expression.expression);
}

function isPlainPropertyAccess(
  expression: ts.Expression,
): expression is ts.PropertyAccessExpression {
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.questionDotToken === undefined
  );
}

function getIdentifierRequireKind(
  bindings: PreparedRequireBindings,
  expression: ts.Identifier,
): ImportRecordKind | null {
  return isUsableRequireBinding(bindings, expression) ? 'commonjs' : null;
}

function getResolveRequireKind(
  bindings: PreparedRequireBindings,
  expression: ts.Expression,
): ImportRecordKind | null {
  if (!isRequireResolveAccess(expression)) return null;
  return isUsableRequireBinding(bindings, expression.expression)
    ? 'require-resolve'
    : null;
}

function getRequireCallKind(options: {
  bindings: PreparedRequireBindings;
  node: ts.CallExpression;
}): ImportRecordKind | null {
  if (options.node.questionDotToken !== undefined) return null;
  const expression = options.node.expression;
  return ts.isIdentifier(expression)
    ? getIdentifierRequireKind(options.bindings, expression)
    : getResolveRequireKind(options.bindings, expression);
}

function getLiteralArgument(
  node: ts.CallExpression,
): ts.StringLiteralLike | null {
  const argument = node.arguments[0];
  return argument !== undefined && ts.isStringLiteralLike(argument)
    ? argument
    : null;
}

function collectCallRecord(options: {
  bindings: PreparedRequireBindings;
  collection: RequireImportCollectionOptions;
  lineStarts: readonly number[];
  node: ts.CallExpression;
  sourceFile: ts.SourceFile;
}): CollectedImportRecord | null {
  const kind = getRequireCallKind({
    bindings: options.bindings,
    node: options.node,
  });
  if (kind === null) return null;
  const argument = getLiteralArgument(options.node);
  if (argument === null) return null;
  return createRequireImportRecord(options, argument, kind);
}

function createRequireImportRecord(
  options: {
    collection: RequireImportCollectionOptions;
    lineStarts: readonly number[];
    sourceFile: ts.SourceFile;
  },
  argument: ts.StringLiteralLike,
  kind: ImportRecordKind,
): CollectedImportRecord {
  return createImportRecord({
    end: argument.getEnd(),
    filePath: options.collection.filePath,
    kind,
    lineOffset: options.collection.lineOffset ?? 0,
    lineStarts: options.lineStarts,
    pos: argument.getStart(options.sourceFile),
    sourceOffset: options.collection.sourceOffset ?? 0,
    specifier: argument.text,
  });
}

function collectRequireRecords(options: {
  bindings: PreparedRequireBindings;
  collection: RequireImportCollectionOptions;
  sourceFile: ts.SourceFile;
}): CollectedImportRecord[] {
  const records: CollectedImportRecord[] = [];
  const lineStarts = buildLineStarts(options.collection.sourceText);
  const visit = (node: ts.Node): void => {
    const record = ts.isCallExpression(node)
      ? collectCallRecord({ ...options, lineStarts, node })
      : null;
    if (record !== null) records.push(record);
    ts.forEachChild(node, visit);
  };
  visit(options.sourceFile);
  return records;
}

export function collectRequireImports(
  options: RequireImportCollectionOptions,
): CollectedImportRecord[] {
  const sourceFile = ts.createSourceFile(
    options.filePath,
    options.sourceText,
    ts.ScriptTarget.Latest,
    true,
    options.scriptKind,
  );
  return collectRequireImportsFromSourceFile({ ...options, sourceFile });
}

export function collectRequireImportsFromSourceFile(
  options: RequireImportCollectionOptions & { sourceFile: ts.SourceFile },
): CollectedImportRecord[] {
  return collectRequireRecords({
    bindings: prepareRequireBindings(options.sourceFile),
    collection: options,
    sourceFile: options.sourceFile,
  });
}
