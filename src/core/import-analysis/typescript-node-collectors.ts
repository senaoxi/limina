import type ts from 'typescript';
import type { ImportRecordKind } from './records';

export type AddTypeScriptImport = (
  specifier: string,
  node: ts.Node,
  kind: ImportRecordKind,
) => void;

type NodeCollector = (
  node: ts.Node,
  add: AddTypeScriptImport,
  tsModule: typeof ts,
) => void;

function getStringLiteralValue(
  node: ts.Node | undefined,
  tsModule: typeof ts,
): string | null {
  if (node === undefined) return null;
  if (!tsModule.isStringLiteralLike(node)) return null;
  return node.text;
}

function hasOnlyTypeElements(
  bindings: ts.NamedImportBindings,
  tsModule: typeof ts,
): boolean {
  if (!tsModule.isNamedImports(bindings)) return false;
  if (bindings.elements.length === 0) return false;
  return bindings.elements.every((element) => element.isTypeOnly);
}

function isNamedBindingOnlyClause(
  clause: ts.ImportClause,
  tsModule: typeof ts,
): boolean {
  if (clause.name !== undefined) return false;
  if (clause.namedBindings === undefined) return false;
  return hasOnlyTypeElements(clause.namedBindings, tsModule);
}

function getImportKind(
  node: ts.ImportDeclaration,
  tsModule: typeof ts,
): ImportRecordKind {
  const clause = node.importClause;
  if (clause === undefined) return 'static';
  return getImportClauseKind(clause, tsModule);
}

function getImportClauseKind(
  clause: ts.ImportClause,
  tsModule: typeof ts,
): ImportRecordKind {
  if (clause.isTypeOnly) return 'import-type';
  return isNamedBindingOnlyClause(clause, tsModule) ? 'import-type' : 'static';
}

function addNodeSpecifier(options: {
  add: AddTypeScriptImport;
  kind: ImportRecordKind;
  node: ts.Node | undefined;
  tsModule: typeof ts;
}): void {
  const specifier = getStringLiteralValue(options.node, options.tsModule);
  if (options.node === undefined) return;
  if (specifier === null) return;
  options.add(specifier, options.node, options.kind);
}

function collectImportDeclaration(
  node: ts.Node,
  add: AddTypeScriptImport,
  tsModule: typeof ts,
): void {
  if (!tsModule.isImportDeclaration(node)) return;
  addNodeSpecifier({
    add,
    kind: getImportKind(node, tsModule),
    node: node.moduleSpecifier,
    tsModule,
  });
}

function collectExportDeclaration(
  node: ts.Node,
  add: AddTypeScriptImport,
  tsModule: typeof ts,
): void {
  if (!tsModule.isExportDeclaration(node)) return;
  addNodeSpecifier({
    add,
    kind: 'export',
    node: node.moduleSpecifier,
    tsModule,
  });
}

function collectImportTypeNode(
  node: ts.Node,
  add: AddTypeScriptImport,
  tsModule: typeof ts,
): void {
  if (!tsModule.isImportTypeNode(node)) return;
  const argument = node.argument;
  const literal = tsModule.isLiteralTypeNode(argument)
    ? argument.literal
    : undefined;
  addNodeSpecifier({ add, kind: 'import-type', node: literal, tsModule });
}

function collectDynamicImport(
  node: ts.Node,
  add: AddTypeScriptImport,
  tsModule: typeof ts,
): void {
  if (!tsModule.isCallExpression(node)) return;
  if (node.expression.kind !== tsModule.SyntaxKind.ImportKeyword) return;
  addNodeSpecifier({ add, kind: 'dynamic', node: node.arguments[0], tsModule });
}

function collectImportEquals(
  node: ts.Node,
  add: AddTypeScriptImport,
  tsModule: typeof ts,
): void {
  if (!tsModule.isImportEqualsDeclaration(node)) return;
  const reference = node.moduleReference;
  const expression = tsModule.isExternalModuleReference(reference)
    ? reference.expression
    : undefined;
  addNodeSpecifier({ add, kind: 'import-equals', node: expression, tsModule });
}

const NODE_COLLECTORS: readonly NodeCollector[] = [
  collectImportDeclaration,
  collectExportDeclaration,
  collectImportTypeNode,
  collectDynamicImport,
  collectImportEquals,
];

export function visitTypeScriptImportNodes(options: {
  add: AddTypeScriptImport;
  node: ts.Node;
  tsModule: typeof ts;
}): void {
  for (const collect of NODE_COLLECTORS) {
    collect(options.node, options.add, options.tsModule);
  }
  options.tsModule.forEachChild(options.node, (child) =>
    visitTypeScriptImportNodes({
      add: options.add,
      node: child,
      tsModule: options.tsModule,
    }),
  );
}
