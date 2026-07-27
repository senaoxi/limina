import ts from 'typescript';
import {
  buildLineStarts,
  type CollectedImportRecord,
  createImportRecord,
  type ImportRecordKind,
} from './records';

interface TypeScriptImportCollectionOptions {
  filePath: string;
  lineOffset?: number;
  scriptKind: ts.ScriptKind;
  sourceOffset?: number;
  sourceText: string;
}

type AddImport = (
  specifier: string,
  node: ts.Node,
  kind: ImportRecordKind,
) => void;

type NodeCollector = (node: ts.Node, add: AddImport) => void;

const SCRIPT_KIND_BY_EXTENSION = new Map<string, ts.ScriptKind>([
  ['.cjs', ts.ScriptKind.JS],
  ['.js', ts.ScriptKind.JS],
  ['.jsx', ts.ScriptKind.JSX],
  ['.mjs', ts.ScriptKind.JS],
  ['.tsx', ts.ScriptKind.TSX],
]);

function getFileExtension(filePath: string): string {
  const index = filePath.lastIndexOf('.');
  if (index === -1) return '';
  return filePath.slice(index);
}

export function getSourceFileKind(filePath: string): ts.ScriptKind {
  return (
    SCRIPT_KIND_BY_EXTENSION.get(getFileExtension(filePath)) ?? ts.ScriptKind.TS
  );
}

function getStringLiteralValue(node: ts.Node | undefined): string | null {
  if (node === undefined) return null;
  if (!ts.isStringLiteralLike(node)) return null;
  return node.text;
}

function hasNamedBindings(
  clause: ts.ImportClause,
): clause is ts.ImportClause & { namedBindings: ts.NamedImportBindings } {
  return clause.namedBindings !== undefined;
}

function hasOnlyTypeElements(bindings: ts.NamedImportBindings): boolean {
  if (!ts.isNamedImports(bindings)) return false;
  if (bindings.elements.length === 0) return false;
  return bindings.elements.every((element) => element.isTypeOnly);
}

function isNamedBindingOnlyClause(clause: ts.ImportClause): boolean {
  if (clause.name !== undefined) return false;
  if (!hasNamedBindings(clause)) return false;
  return hasOnlyTypeElements(clause.namedBindings);
}

function isTypeOnlyClause(clause: ts.ImportClause): boolean {
  if (clause.isTypeOnly) return true;
  return isNamedBindingOnlyClause(clause);
}

function getImportKind(node: ts.ImportDeclaration): ImportRecordKind {
  const clause = node.importClause;
  if (clause === undefined) return 'static';
  return isTypeOnlyClause(clause) ? 'import-type' : 'static';
}

function addNodeSpecifier(options: {
  add: AddImport;
  kind: ImportRecordKind;
  node: ts.Node | undefined;
}): void {
  const specifier = getStringLiteralValue(options.node);
  if (options.node === undefined) return;
  if (specifier === null) return;
  options.add(specifier, options.node, options.kind);
}

function collectImportDeclaration(node: ts.Node, add: AddImport): void {
  if (!ts.isImportDeclaration(node)) return;
  addNodeSpecifier({
    add,
    kind: getImportKind(node),
    node: node.moduleSpecifier,
  });
}

function collectExportDeclaration(node: ts.Node, add: AddImport): void {
  if (!ts.isExportDeclaration(node)) return;
  addNodeSpecifier({ add, kind: 'export', node: node.moduleSpecifier });
}

function getImportTypeLiteral(node: ts.ImportTypeNode): ts.Node | undefined {
  if (!ts.isLiteralTypeNode(node.argument)) return undefined;
  return node.argument.literal;
}

function collectImportTypeNode(node: ts.Node, add: AddImport): void {
  if (!ts.isImportTypeNode(node)) return;
  addNodeSpecifier({
    add,
    kind: 'import-type',
    node: getImportTypeLiteral(node),
  });
}

function getCallArgument(node: ts.CallExpression): ts.Expression | undefined {
  return node.arguments[0];
}

function isDynamicImportCall(node: ts.CallExpression): boolean {
  return node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

function collectDynamicImport(node: ts.Node, add: AddImport): void {
  if (!ts.isCallExpression(node)) return;
  if (!isDynamicImportCall(node)) return;
  addNodeSpecifier({ add, kind: 'dynamic', node: getCallArgument(node) });
}

function isNamedIdentifier(node: ts.Node, name: string): boolean {
  if (!ts.isIdentifier(node)) return false;
  return node.text === name;
}

function isRequireCall(node: ts.CallExpression): boolean {
  return isNamedIdentifier(node.expression, 'require');
}

function collectRequireCall(node: ts.Node, add: AddImport): void {
  if (!ts.isCallExpression(node)) return;
  if (!isRequireCall(node)) return;
  addNodeSpecifier({ add, kind: 'commonjs', node: getCallArgument(node) });
}

function isRequireObject(node: ts.PropertyAccessExpression): boolean {
  return isNamedIdentifier(node.expression, 'require');
}

function isResolveProperty(node: ts.PropertyAccessExpression): boolean {
  return node.name.text === 'resolve';
}

function isRequireResolveCall(node: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  if (!isRequireObject(node.expression)) return false;
  return isResolveProperty(node.expression);
}

function collectRequireResolve(node: ts.Node, add: AddImport): void {
  if (!ts.isCallExpression(node)) return;
  if (!isRequireResolveCall(node)) return;
  addNodeSpecifier({
    add,
    kind: 'require-resolve',
    node: getCallArgument(node),
  });
}

function getImportEqualsExpression(
  node: ts.ImportEqualsDeclaration,
): ts.Expression | undefined {
  if (!ts.isExternalModuleReference(node.moduleReference)) return undefined;
  return node.moduleReference.expression;
}

function collectImportEquals(node: ts.Node, add: AddImport): void {
  if (!ts.isImportEqualsDeclaration(node)) return;
  addNodeSpecifier({
    add,
    kind: 'import-equals',
    node: getImportEqualsExpression(node),
  });
}

const NODE_COLLECTORS: readonly NodeCollector[] = [
  collectImportDeclaration,
  collectExportDeclaration,
  collectImportTypeNode,
  collectDynamicImport,
  collectRequireCall,
  collectRequireResolve,
  collectImportEquals,
];

function createAddImport(options: {
  collection: TypeScriptImportCollectionOptions;
  imports: CollectedImportRecord[];
  lineStarts: number[];
  sourceFile: ts.SourceFile;
}): AddImport {
  const lineOffset = options.collection.lineOffset ?? 0;
  const sourceOffset = options.collection.sourceOffset ?? 0;
  return (specifier, node, kind) => {
    options.imports.push(
      createImportRecord({
        end: node.getEnd(),
        filePath: options.collection.filePath,
        kind,
        lineOffset,
        lineStarts: options.lineStarts,
        pos: node.getStart(options.sourceFile),
        sourceOffset,
        specifier,
      }),
    );
  };
}

function visitNode(options: { add: AddImport; node: ts.Node }): void {
  for (const collect of NODE_COLLECTORS) collect(options.node, options.add);
  ts.forEachChild(options.node, (child) =>
    visitNode({ add: options.add, node: child }),
  );
}

export function collectTypeScriptImports(
  options: TypeScriptImportCollectionOptions,
): CollectedImportRecord[] {
  const sourceFile = ts.createSourceFile(
    options.filePath,
    options.sourceText,
    ts.ScriptTarget.Latest,
    true,
    options.scriptKind,
  );
  const imports: CollectedImportRecord[] = [];
  const add = createAddImport({
    collection: options,
    imports,
    lineStarts: buildLineStarts(options.sourceText),
    sourceFile,
  });
  visitNode({ add, node: sourceFile });
  return imports;
}
