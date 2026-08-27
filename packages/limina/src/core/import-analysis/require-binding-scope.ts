import type ts from 'typescript';
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

function createsBlockScope(node: ts.Node, tsModule: typeof ts): boolean {
  const blockScopePredicates: readonly ((value: ts.Node) => boolean)[] = [
    tsModule.isBlock,
    tsModule.isCaseBlock,
    tsModule.isClassLike,
    tsModule.isForStatement,
    tsModule.isForInStatement,
    tsModule.isForOfStatement,
    tsModule.isModuleBlock,
  ];
  return blockScopePredicates.some((predicate) => predicate(node));
}

function registerFunctionName(
  node: ts.SignatureDeclaration,
  scope: LexicalScope,
  tsModule: typeof ts,
): void {
  if (!tsModule.isFunctionExpression(node) || node.name === undefined) return;
  registerBinding(scope, node.name);
}

function registerFunctionParameters(
  node: ts.SignatureDeclaration,
  scope: LexicalScope,
  tsModule: typeof ts,
): void {
  for (const parameter of node.parameters) {
    for (const identifier of getBindingNames(parameter.name, tsModule)) {
      registerBinding(scope, identifier);
    }
  }
}

function createFunctionScope(
  node: ts.Node,
  parent: LexicalScope,
  tsModule: typeof ts,
): LexicalScope | null {
  if (!tsModule.isFunctionLike(node)) return null;
  const scope = createScope('function', parent);
  registerFunctionName(node, scope, tsModule);
  registerFunctionParameters(node, scope, tsModule);
  return scope;
}

function createCatchScope(
  node: ts.Node,
  parent: LexicalScope,
  tsModule: typeof ts,
): LexicalScope | null {
  if (!tsModule.isCatchClause(node)) return null;
  const scope = createScope('block', parent);
  registerCatchVariable(node.variableDeclaration, scope, tsModule);
  return scope;
}

function registerCatchVariable(
  declaration: ts.VariableDeclaration | undefined,
  scope: LexicalScope,
  tsModule: typeof ts,
): void {
  if (declaration === undefined) return;
  for (const identifier of getBindingNames(declaration.name, tsModule)) {
    registerBinding(scope, identifier);
  }
}

function registerClassExpressionName(
  node: ts.Node,
  scope: LexicalScope,
  tsModule: typeof ts,
): void {
  if (!tsModule.isClassExpression(node)) return;
  if (node.name !== undefined) registerBinding(scope, node.name);
}

interface ScopeBuildContext {
  sourceFile: ts.SourceFile;
  tsModule: typeof ts;
}

function createBlockScope(
  node: ts.Node,
  parent: LexicalScope,
  context: ScopeBuildContext,
): LexicalScope | null {
  if (node === context.sourceFile) return null;
  if (!createsBlockScope(node, context.tsModule)) return null;
  const scope = createScope('block', parent);
  registerClassExpressionName(node, scope, context.tsModule);
  return scope;
}

function selectNodeScope(
  node: ts.Node,
  incoming: LexicalScope,
  context: ScopeBuildContext,
): LexicalScope {
  const candidates = [
    createFunctionScope(node, incoming, context.tsModule),
    createCatchScope(node, incoming, context.tsModule),
    createBlockScope(node, incoming, context),
  ];
  return candidates.find((candidate) => candidate !== null) ?? incoming;
}

function buildScopeGraph(
  sourceFile: ts.SourceFile,
  tsModule: typeof ts,
): RequireScopeGraph {
  const root = createScope('root');
  const context = { sourceFile, tsModule };
  const nodeScopes = new Map<ts.Node, LexicalScope>();
  const visit = (node: ts.Node, incoming: LexicalScope): void => {
    registerDeclaration(node, incoming, tsModule);
    const active = selectNodeScope(node, incoming, context);
    nodeScopes.set(node, active);
    tsModule.forEachChild(node, (child) => visit(child, active));
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
  tsModule: typeof ts,
): RequireScopeGraph {
  return buildScopeGraph(sourceFile, tsModule);
}
