import ts from 'typescript';
import {
  getBindingNames,
  registerBinding,
  registerDeclaration,
} from './require-binding-declarations';

export type BindingKind = 'create-require-import' | 'normal' | 'require-alias';

export interface RequireBinding {
  declarations: ts.Node[];
  kind: BindingKind;
}

export interface LexicalScope {
  bindings: Map<string, RequireBinding>;
  parent?: LexicalScope;
  type: 'block' | 'function' | 'root';
}

export interface RequireScopeGraph {
  nodeScopes: Map<ts.Node, LexicalScope>;
  root: LexicalScope;
}

export interface PreparedRequireBindings {
  graph: RequireScopeGraph;
  reassigned: ReadonlySet<RequireBinding>;
}

function createScope(
  type: LexicalScope['type'],
  parent?: LexicalScope,
): LexicalScope {
  return { bindings: new Map(), parent, type };
}

const blockScopePredicates: readonly ((node: ts.Node) => boolean)[] = [
  ts.isBlock,
  ts.isCaseBlock,
  ts.isClassLike,
  ts.isForStatement,
  ts.isForInStatement,
  ts.isForOfStatement,
  ts.isModuleBlock,
];

function createsBlockScope(node: ts.Node): boolean {
  return blockScopePredicates.some((predicate) => predicate(node));
}

function registerFunctionName(
  node: ts.SignatureDeclaration,
  scope: LexicalScope,
): void {
  if (!ts.isFunctionExpression(node) || node.name === undefined) return;
  registerBinding(scope, node.name);
}

function registerFunctionParameters(
  node: ts.SignatureDeclaration,
  scope: LexicalScope,
): void {
  for (const parameter of node.parameters) {
    for (const identifier of getBindingNames(parameter.name)) {
      registerBinding(scope, identifier);
    }
  }
}

function createFunctionScope(
  node: ts.Node,
  parent: LexicalScope,
): LexicalScope | null {
  if (!ts.isFunctionLike(node)) return null;
  const scope = createScope('function', parent);
  registerFunctionName(node, scope);
  registerFunctionParameters(node, scope);
  return scope;
}

function createCatchScope(
  node: ts.Node,
  parent: LexicalScope,
): LexicalScope | null {
  if (!ts.isCatchClause(node)) return null;
  const scope = createScope('block', parent);
  registerCatchVariable(node.variableDeclaration, scope);
  return scope;
}

function registerCatchVariable(
  declaration: ts.VariableDeclaration | undefined,
  scope: LexicalScope,
): void {
  if (declaration === undefined) return;
  for (const identifier of getBindingNames(declaration.name)) {
    registerBinding(scope, identifier);
  }
}

function registerClassExpressionName(node: ts.Node, scope: LexicalScope): void {
  if (!ts.isClassExpression(node)) return;
  if (node.name !== undefined) registerBinding(scope, node.name);
}

function createBlockScope(
  node: ts.Node,
  parent: LexicalScope,
  sourceFile: ts.SourceFile,
): LexicalScope | null {
  if (node === sourceFile) return null;
  if (!createsBlockScope(node)) return null;
  const scope = createScope('block', parent);
  registerClassExpressionName(node, scope);
  return scope;
}

function selectNodeScope(
  node: ts.Node,
  incoming: LexicalScope,
  sourceFile: ts.SourceFile,
): LexicalScope {
  const candidates = [
    createFunctionScope(node, incoming),
    createCatchScope(node, incoming),
    createBlockScope(node, incoming, sourceFile),
  ];
  return candidates.find((candidate) => candidate !== null) ?? incoming;
}

function buildScopeGraph(sourceFile: ts.SourceFile): RequireScopeGraph {
  const root = createScope('root');
  const nodeScopes = new Map<ts.Node, LexicalScope>();
  const visit = (node: ts.Node, incoming: LexicalScope): void => {
    registerDeclaration(node, incoming);
    const active = selectNodeScope(node, incoming, sourceFile);
    nodeScopes.set(node, active);
    ts.forEachChild(node, (child) => visit(child, active));
  };
  visit(sourceFile, root);
  return { nodeScopes, root };
}

export function resolveRequireBinding(
  graph: RequireScopeGraph,
  node: ts.Node,
  name: string,
): RequireBinding | undefined {
  let scope = graph.nodeScopes.get(node);
  while (scope !== undefined) {
    const binding = scope.bindings.get(name);
    if (binding !== undefined) return binding;
    scope = scope.parent;
  }
  return undefined;
}

export function createRequireScopeGraph(
  sourceFile: ts.SourceFile,
): RequireScopeGraph {
  return buildScopeGraph(sourceFile);
}
