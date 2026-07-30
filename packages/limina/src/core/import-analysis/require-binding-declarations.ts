import ts from 'typescript';
import type {
  BindingKind,
  LexicalScope,
  RequireBinding,
} from './require-binding-scope';

export function getBindingNames(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : getBindingNames(element.name),
  );
}

export function registerBinding(
  scope: LexicalScope,
  identifier: ts.Identifier,
  kind: BindingKind = 'normal',
): RequireBinding {
  const existing = scope.bindings.get(identifier.text);
  if (existing !== undefined) {
    existing.declarations.push(identifier);
    existing.kind = 'normal';
    return existing;
  }
  const binding = { declarations: [identifier], kind };
  scope.bindings.set(identifier.text, binding);
  return binding;
}

function getFunctionScope(scope: LexicalScope): LexicalScope {
  let current = scope;
  while (current.type === 'block' && current.parent !== undefined) {
    current = current.parent;
  }
  return current;
}

function isVarDeclaration(node: ts.VariableDeclaration): boolean {
  return (
    ts.isVariableDeclarationList(node.parent) &&
    (node.parent.flags & ts.NodeFlags.BlockScoped) === 0
  );
}

function registerVariableDeclaration(
  node: ts.VariableDeclaration,
  scope: LexicalScope,
): void {
  const target = isVarDeclaration(node) ? getFunctionScope(scope) : scope;
  for (const identifier of getBindingNames(node.name)) {
    registerBinding(target, identifier);
  }
}

function getImportDeclaration(
  node: ts.ImportSpecifier,
): ts.ImportDeclaration | null {
  const declaration = node.parent.parent.parent;
  return ts.isImportDeclaration(declaration) ? declaration : null;
}

function isCreateRequireModule(declaration: ts.ImportDeclaration): boolean {
  if (!ts.isStringLiteral(declaration.moduleSpecifier)) return false;
  return ['module', 'node:module'].includes(declaration.moduleSpecifier.text);
}

function isCreateRequireImport(node: ts.ImportSpecifier): boolean {
  const declaration = getImportDeclaration(node);
  return (
    isCreateRequireImportDeclaration(declaration) &&
    getImportedName(node) === 'createRequire'
  );
}

function isCreateRequireImportDeclaration(
  declaration: ts.ImportDeclaration | null,
): declaration is ts.ImportDeclaration {
  if (declaration === null) return false;
  return isCreateRequireModule(declaration);
}

function getImportedName(node: ts.ImportSpecifier): string {
  return node.propertyName?.text ?? node.name.text;
}

function getImportSpecifierKind(node: ts.ImportSpecifier): BindingKind {
  return isCreateRequireImport(node) ? 'create-require-import' : 'normal';
}

function registerImportSpecifier(
  element: ts.ImportSpecifier,
  scope: LexicalScope,
): void {
  if (element.isTypeOnly) return;
  registerBinding(scope, element.name, getImportSpecifierKind(element));
}

function registerImportSpecifiers(
  named: ts.NamedImports,
  scope: LexicalScope,
): void {
  for (const element of named.elements) {
    registerImportSpecifier(element, scope);
  }
}

function registerNamedImportBindings(
  named: ts.NamedImportBindings | undefined,
  scope: LexicalScope,
): void {
  if (named === undefined) return;
  if (ts.isNamespaceImport(named)) {
    registerBinding(scope, named.name);
    return;
  }
  registerImportSpecifiers(named, scope);
}

function registerDefaultImportBinding(
  clause: ts.ImportClause,
  scope: LexicalScope,
): void {
  if (clause.name !== undefined) registerBinding(scope, clause.name);
}

function registerImportBindings(
  node: ts.ImportDeclaration,
  scope: LexicalScope,
): void {
  const clause = node.importClause;
  if (clause === undefined) return;
  if (clause.isTypeOnly) return;
  registerDefaultImportBinding(clause, scope);
  registerNamedImportBindings(clause.namedBindings, scope);
}

type DeclarationRegistrar = (node: ts.Node, scope: LexicalScope) => boolean;

const declarationRegistrars: readonly DeclarationRegistrar[] = [
  (node, scope) => {
    if (!ts.isVariableDeclaration(node)) return false;
    registerVariableDeclaration(node, scope);
    return true;
  },
  (node, scope) => {
    if (!ts.isFunctionDeclaration(node) || node.name === undefined)
      return false;
    registerBinding(scope, node.name);
    return true;
  },
  (node, scope) => {
    if (!ts.isClassDeclaration(node) || node.name === undefined) return false;
    registerBinding(scope, node.name);
    return true;
  },
  (node, scope) => {
    if (!ts.isEnumDeclaration(node)) return false;
    registerBinding(scope, node.name);
    return true;
  },
  (node, scope) => {
    if (!ts.isImportDeclaration(node)) return false;
    registerImportBindings(node, scope);
    return true;
  },
  (node, scope) => {
    if (!ts.isImportEqualsDeclaration(node) || node.isTypeOnly) return false;
    registerBinding(scope, node.name);
    return true;
  },
];

export function registerDeclaration(node: ts.Node, scope: LexicalScope): void {
  for (const register of declarationRegistrars) {
    if (register(node, scope)) return;
  }
}
