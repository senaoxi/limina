import ts from 'typescript';
import {
  createRequireScopeGraph,
  type PreparedRequireBindings,
  type RequireBinding,
  type RequireScopeGraph,
  resolveRequireBinding,
} from './require-binding-scope';

function isPlainSingleArgumentCall(
  node: ts.Expression,
): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    node.questionDotToken === undefined &&
    node.arguments.length === 1
  );
}

function isImportMeta(node: ts.Expression): boolean {
  if (!ts.isMetaProperty(node)) return false;
  return (
    node.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.name.text === 'meta'
  );
}

function isImportMetaUrl(node: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(node)) return false;
  if (!isPlainUrlAccess(node)) return false;
  return isImportMeta(node.expression);
}

function isPlainUrlAccess(node: ts.PropertyAccessExpression): boolean {
  return node.questionDotToken === undefined && node.name.text === 'url';
}

function isCreateRequireCallee(
  graph: RequireScopeGraph,
  node: ts.Expression,
): boolean {
  if (!ts.isIdentifier(node)) return false;
  return (
    resolveRequireBinding(graph, node, node.text)?.kind ===
    'create-require-import'
  );
}

function isDirectCreateRequireCall(
  graph: RequireScopeGraph,
  node: ts.Expression,
): boolean {
  if (!isPlainSingleArgumentCall(node)) return false;
  if (!isImportMetaUrl(node.arguments[0]!)) return false;
  return isCreateRequireCallee(graph, node.expression);
}

function isConstDeclaration(node: ts.VariableDeclaration): boolean {
  return (
    ts.isVariableDeclarationList(node.parent) &&
    (node.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

function hasDirectCreateRequireInitializer(
  graph: RequireScopeGraph,
  node: ts.VariableDeclaration,
): boolean {
  if (node.initializer === undefined) return false;
  if (!isConstDeclaration(node)) return false;
  return isDirectCreateRequireCall(graph, node.initializer);
}

function getRequireAliasDeclaration(
  graph: RequireScopeGraph,
  node: ts.Node,
): ts.VariableDeclaration | null {
  if (!isIdentifierVariableDeclaration(node)) return null;
  return hasDirectCreateRequireInitializer(graph, node) ? node : null;
}

function isIdentifierVariableDeclaration(
  node: ts.Node,
): node is ts.VariableDeclaration & { name: ts.Identifier } {
  return ts.isVariableDeclaration(node) && ts.isIdentifier(node.name);
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
): void {
  const visit = (node: ts.Node): void => {
    const declaration = getRequireAliasDeclaration(graph, node);
    if (declaration !== null) markRequireAlias(graph, declaration);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment
  );
}

function getBinaryAssignmentTarget(node: ts.Node): ts.Expression | null {
  if (!ts.isBinaryExpression(node)) return null;
  if (!isAssignmentOperator(node.operatorToken.kind)) return null;
  return node.left;
}

function isUpdateOperator(kind: ts.SyntaxKind): boolean {
  return [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(
    kind,
  );
}

function getUnaryAssignmentTarget(node: ts.Node): ts.Expression | null {
  if (!isUnaryUpdateExpression(node)) return null;
  if (!isUpdateOperator(node.operator)) return null;
  return node.operand;
}

function isUnaryUpdateExpression(
  node: ts.Node,
): node is ts.PrefixUnaryExpression | ts.PostfixUnaryExpression {
  return ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node);
}

function getAssignmentTarget(node: ts.Node): ts.Expression | null {
  return getBinaryAssignmentTarget(node) ?? getUnaryAssignmentTarget(node);
}

function recordReassignedBinding(
  graph: RequireScopeGraph,
  reassigned: Set<RequireBinding>,
  node: ts.Expression,
): void {
  const binding = getRequireAliasBinding(graph, node);
  if (binding !== undefined) reassigned.add(binding);
}

function getRequireAliasBinding(
  graph: RequireScopeGraph,
  node: ts.Expression,
): RequireBinding | undefined {
  if (!ts.isIdentifier(node)) return undefined;
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
): Set<RequireBinding> {
  const reassigned = new Set<RequireBinding>();
  const visit = (node: ts.Node): void => {
    const target = getAssignmentTarget(node);
    if (target !== null) recordReassignedBinding(graph, reassigned, target);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return reassigned;
}

export function prepareRequireBindings(
  sourceFile: ts.SourceFile,
): PreparedRequireBindings {
  const graph = createRequireScopeGraph(sourceFile);
  registerRequireAliases(graph, sourceFile);
  return { graph, reassigned: collectReassignedBindings(graph, sourceFile) };
}
