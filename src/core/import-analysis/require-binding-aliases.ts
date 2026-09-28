import type ts from 'typescript';
import {
  createRequireScopeGraph,
  type PreparedRequireBindings,
  type RequireBinding,
  type RequireScopeGraph,
  resolveRequireBinding,
} from './require-binding-scope';

function isPlainSingleArgumentCall(
  node: ts.Expression,
  tsModule: typeof ts,
): node is ts.CallExpression {
  return (
    tsModule.isCallExpression(node) &&
    node.questionDotToken === undefined &&
    node.arguments.length === 1
  );
}

function isImportMeta(node: ts.Expression, tsModule: typeof ts): boolean {
  if (!tsModule.isMetaProperty(node)) return false;
  return (
    node.keywordToken === tsModule.SyntaxKind.ImportKeyword &&
    node.name.text === 'meta'
  );
}

function isImportMetaUrl(node: ts.Expression, tsModule: typeof ts): boolean {
  if (!tsModule.isPropertyAccessExpression(node)) return false;
  if (!isPlainUrlAccess(node)) return false;
  return isImportMeta(node.expression, tsModule);
}

function isPlainUrlAccess(node: ts.PropertyAccessExpression): boolean {
  return node.questionDotToken === undefined && node.name.text === 'url';
}

function isCreateRequireCallee(
  graph: RequireScopeGraph,
  node: ts.Expression,
  tsModule: typeof ts,
): boolean {
  if (!tsModule.isIdentifier(node)) return false;
  return (
    resolveRequireBinding(graph, node, node.text)?.kind ===
    'create-require-import'
  );
}

function isDirectCreateRequireCall(
  graph: RequireScopeGraph,
  node: ts.Expression,
  tsModule: typeof ts,
): boolean {
  if (!isPlainSingleArgumentCall(node, tsModule)) return false;
  if (!isImportMetaUrl(node.arguments[0]!, tsModule)) return false;
  return isCreateRequireCallee(graph, node.expression, tsModule);
}

function isConstDeclaration(
  node: ts.VariableDeclaration,
  tsModule: typeof ts,
): boolean {
  return (
    tsModule.isVariableDeclarationList(node.parent) &&
    (node.parent.flags & tsModule.NodeFlags.Const) !== 0
  );
}

function hasDirectCreateRequireInitializer(
  graph: RequireScopeGraph,
  node: ts.VariableDeclaration,
  tsModule: typeof ts,
): boolean {
  if (node.initializer === undefined) return false;
  if (!isConstDeclaration(node, tsModule)) return false;
  return isDirectCreateRequireCall(graph, node.initializer, tsModule);
}

function getRequireAliasDeclaration(
  graph: RequireScopeGraph,
  node: ts.Node,
  tsModule: typeof ts,
): ts.VariableDeclaration | null {
  if (!isIdentifierVariableDeclaration(node, tsModule)) return null;
  return hasDirectCreateRequireInitializer(graph, node, tsModule) ? node : null;
}

function isIdentifierVariableDeclaration(
  node: ts.Node,
  tsModule: typeof ts,
): node is ts.VariableDeclaration & { name: ts.Identifier } {
  return (
    tsModule.isVariableDeclaration(node) && tsModule.isIdentifier(node.name)
  );
}

function isOnlyBindingDeclaration(
  binding: RequireBinding,
  name: ts.Identifier,
): boolean {
  return binding.declarations.length === 1 && binding.declarations[0] === name;
}

function markRequireAlias(
  graph: RequireScopeGraph,
  node: ts.VariableDeclaration,
): void {
  const name = node.name as ts.Identifier;
  const binding = resolveRequireBinding(graph, name, name.text);
  if (binding === undefined) return;
  if (isOnlyBindingDeclaration(binding, name)) binding.kind = 'require-alias';
}

function registerRequireAliases(
  graph: RequireScopeGraph,
  sourceFile: ts.SourceFile,
  tsModule: typeof ts,
): void {
  const visit = (node: ts.Node): void => {
    const declaration = getRequireAliasDeclaration(graph, node, tsModule);
    if (declaration !== null) markRequireAlias(graph, declaration);
    tsModule.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function isAssignmentOperator(
  kind: ts.SyntaxKind,
  tsModule: typeof ts,
): boolean {
  return (
    kind >= tsModule.SyntaxKind.FirstAssignment &&
    kind <= tsModule.SyntaxKind.LastAssignment
  );
}

function getBinaryAssignmentTarget(
  node: ts.Node,
  tsModule: typeof ts,
): ts.Expression | null {
  if (!tsModule.isBinaryExpression(node)) return null;
  if (!isAssignmentOperator(node.operatorToken.kind, tsModule)) return null;
  return node.left;
}

function isUpdateOperator(kind: ts.SyntaxKind, tsModule: typeof ts): boolean {
  return [
    tsModule.SyntaxKind.PlusPlusToken,
    tsModule.SyntaxKind.MinusMinusToken,
  ].includes(kind);
}

function getUnaryAssignmentTarget(
  node: ts.Node,
  tsModule: typeof ts,
): ts.Expression | null {
  if (!isUnaryUpdateExpression(node, tsModule)) return null;
  if (!isUpdateOperator(node.operator, tsModule)) return null;
  return node.operand;
}

function isUnaryUpdateExpression(
  node: ts.Node,
  tsModule: typeof ts,
): node is ts.PrefixUnaryExpression | ts.PostfixUnaryExpression {
  return (
    tsModule.isPrefixUnaryExpression(node) ||
    tsModule.isPostfixUnaryExpression(node)
  );
}

function getAssignmentTarget(
  node: ts.Node,
  tsModule: typeof ts,
): ts.Expression | null {
  return (
    getBinaryAssignmentTarget(node, tsModule) ??
    getUnaryAssignmentTarget(node, tsModule)
  );
}

function recordReassignedBinding(options: {
  graph: RequireScopeGraph;
  node: ts.Expression;
  reassigned: Set<RequireBinding>;
  tsModule: typeof ts;
}): void {
  const binding = getRequireAliasBinding(
    options.graph,
    options.node,
    options.tsModule,
  );
  if (binding !== undefined) options.reassigned.add(binding);
}

function getRequireAliasBinding(
  graph: RequireScopeGraph,
  node: ts.Expression,
  tsModule: typeof ts,
): RequireBinding | undefined {
  if (!tsModule.isIdentifier(node)) return undefined;
  const binding = resolveRequireBinding(graph, node, node.text);
  return asRequireAlias(binding);
}

function asRequireAlias(
  binding: RequireBinding | undefined,
): RequireBinding | undefined {
  if (binding === undefined) return undefined;
  return binding.kind === 'require-alias' ? binding : undefined;
}

function collectReassignedBindings(
  graph: RequireScopeGraph,
  sourceFile: ts.SourceFile,
  tsModule: typeof ts,
): Set<RequireBinding> {
  const reassigned = new Set<RequireBinding>();
  const visit = (node: ts.Node): void => {
    const target = getAssignmentTarget(node, tsModule);
    if (target !== null)
      recordReassignedBinding({ graph, node: target, reassigned, tsModule });
    tsModule.forEachChild(node, visit);
  };
  visit(sourceFile);
  return reassigned;
}

export function prepareRequireBindings(
  sourceFile: ts.SourceFile,
  tsModule: typeof ts,
): PreparedRequireBindings {
  const graph = createRequireScopeGraph(sourceFile, tsModule);
  registerRequireAliases(graph, sourceFile, tsModule);
  return {
    graph,
    reassigned: collectReassignedBindings(graph, sourceFile, tsModule),
  };
}
