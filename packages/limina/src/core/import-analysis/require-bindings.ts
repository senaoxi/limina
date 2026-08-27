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
  tsModule?: typeof ts;
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
  tsModule: typeof ts,
): expression is ts.PropertyAccessExpression & {
  expression: ts.Identifier;
} {
  if (!isPlainPropertyAccess(expression, tsModule)) return false;
  if (expression.name.text !== 'resolve') return false;
  return tsModule.isIdentifier(expression.expression);
}

function isPlainPropertyAccess(
  expression: ts.Expression,
  tsModule: typeof ts,
): expression is ts.PropertyAccessExpression {
  return (
    tsModule.isPropertyAccessExpression(expression) &&
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
  tsModule: typeof ts,
): ImportRecordKind | null {
  if (!isRequireResolveAccess(expression, tsModule)) return null;
  return isUsableRequireBinding(bindings, expression.expression)
    ? 'require-resolve'
    : null;
}

function getRequireCallKind(options: {
  bindings: PreparedRequireBindings;
  node: ts.CallExpression;
  tsModule: typeof ts;
}): ImportRecordKind | null {
  if (options.node.questionDotToken !== undefined) return null;
  const expression = options.node.expression;
  return options.tsModule.isIdentifier(expression)
    ? getIdentifierRequireKind(options.bindings, expression)
    : getResolveRequireKind(options.bindings, expression, options.tsModule);
}

function getLiteralArgument(
  node: ts.CallExpression,
  tsModule: typeof ts,
): ts.StringLiteralLike | null {
  const argument = node.arguments[0];
  return argument !== undefined && tsModule.isStringLiteralLike(argument)
    ? argument
    : null;
}

function collectCallRecord(options: {
  bindings: PreparedRequireBindings;
  collection: RequireImportCollectionOptions;
  lineStarts: readonly number[];
  node: ts.CallExpression;
  sourceFile: ts.SourceFile;
  tsModule: typeof ts;
}): CollectedImportRecord | null {
  const kind = getRequireCallKind({
    bindings: options.bindings,
    node: options.node,
    tsModule: options.tsModule,
  });
  if (kind === null) return null;
  const argument = getLiteralArgument(options.node, options.tsModule);
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
  tsModule: typeof ts;
}): CollectedImportRecord[] {
  const records: CollectedImportRecord[] = [];
  const lineStarts = buildLineStarts(options.collection.sourceText);
  const visit = (node: ts.Node): void => {
    const record = options.tsModule.isCallExpression(node)
      ? collectCallRecord({ ...options, lineStarts, node })
      : null;
    if (record !== null) records.push(record);
    options.tsModule.forEachChild(node, visit);
  };
  visit(options.sourceFile);
  return records;
}

export function collectRequireImports(
  options: RequireImportCollectionOptions,
): CollectedImportRecord[] {
  const tsModule = options.tsModule ?? ts;
  const sourceFile = tsModule.createSourceFile(
    options.filePath,
    options.sourceText,
    tsModule.ScriptTarget.Latest,
    true,
    options.scriptKind,
  );
  return collectRequireImportsFromSourceFile({
    ...options,
    sourceFile,
    tsModule,
  });
}

export function collectRequireImportsFromSourceFile(
  options: RequireImportCollectionOptions & { sourceFile: ts.SourceFile },
): CollectedImportRecord[] {
  const tsModule = options.tsModule ?? ts;
  return collectRequireRecords({
    bindings: prepareRequireBindings(options.sourceFile, tsModule),
    collection: options,
    sourceFile: options.sourceFile,
    tsModule,
  });
}
