import type ts from 'typescript';
import type {
  BindingKind,
  LexicalScope,
  RequireBinding,
} from './require-binding-scope';

export function getBindingNames(
  name: ts.BindingName,
  tsModule: typeof ts,
): ts.Identifier[] {
  if (tsModule.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) =>
    tsModule.isOmittedExpression(element)
      ? []
      : getBindingNames(element.name, tsModule),
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

function isVarDeclaration(
  node: ts.VariableDeclaration,
  tsModule: typeof ts,
): boolean {
  return (
    tsModule.isVariableDeclarationList(node.parent) &&
    (node.parent.flags & tsModule.NodeFlags.BlockScoped) === 0
  );
}

function registerVariableDeclaration(
  node: ts.VariableDeclaration,
  scope: LexicalScope,
  tsModule: typeof ts,
): void {
  const target = isVarDeclaration(node, tsModule)
    ? getFunctionScope(scope)
    : scope;
  for (const identifier of getBindingNames(node.name, tsModule)) {
    registerBinding(target, identifier);
  }
}

function getImportDeclaration(
  node: ts.ImportSpecifier,
  tsModule: typeof ts,
): ts.ImportDeclaration | null {
  const declaration = node.parent.parent.parent;
  return tsModule.isImportDeclaration(declaration) ? declaration : null;
}

function isCreateRequireModule(
  declaration: ts.ImportDeclaration,
  tsModule: typeof ts,
): boolean {
  if (!tsModule.isStringLiteral(declaration.moduleSpecifier)) return false;
  return ['module', 'node:module'].includes(declaration.moduleSpecifier.text);
}

function isCreateRequireImport(
  node: ts.ImportSpecifier,
  tsModule: typeof ts,
): boolean {
  const declaration = getImportDeclaration(node, tsModule);
  return (
    isCreateRequireImportDeclaration(declaration, tsModule) &&
    getImportedName(node) === 'createRequire'
  );
}

function isCreateRequireImportDeclaration(
  declaration: ts.ImportDeclaration | null,
  tsModule: typeof ts,
): declaration is ts.ImportDeclaration {
  if (declaration === null) return false;
  return isCreateRequireModule(declaration, tsModule);
}

function getImportedName(node: ts.ImportSpecifier): string {
  return node.propertyName?.text ?? node.name.text;
}

function getImportSpecifierKind(
  node: ts.ImportSpecifier,
  tsModule: typeof ts,
): BindingKind {
  return isCreateRequireImport(node, tsModule)
    ? 'create-require-import'
    : 'normal';
}

function registerImportSpecifier(
  element: ts.ImportSpecifier,
  scope: LexicalScope,
  tsModule: typeof ts,
): void {
  if (element.isTypeOnly) return;
  registerBinding(
    scope,
    element.name,
    getImportSpecifierKind(element, tsModule),
  );
}

function registerImportSpecifiers(
  named: ts.NamedImports,
  scope: LexicalScope,
  tsModule: typeof ts,
): void {
  for (const element of named.elements) {
    registerImportSpecifier(element, scope, tsModule);
  }
}

function registerNamedImportBindings(
  named: ts.NamedImportBindings | undefined,
  scope: LexicalScope,
  tsModule: typeof ts,
): void {
  if (named === undefined) return;
  if (tsModule.isNamespaceImport(named)) {
    registerBinding(scope, named.name);
    return;
  }
  registerImportSpecifiers(named, scope, tsModule);
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
  tsModule: typeof ts,
): void {
  const clause = node.importClause;
  if (clause === undefined) return;
  if (clause.isTypeOnly) return;
  registerDefaultImportBinding(clause, scope);
  registerNamedImportBindings(clause.namedBindings, scope, tsModule);
}

type DeclarationRegistrar = (
  node: ts.Node,
  scope: LexicalScope,
  tsModule: typeof ts,
) => boolean;

const declarationRegistrars: readonly DeclarationRegistrar[] = [
  (node, scope, tsModule) => {
    if (!tsModule.isVariableDeclaration(node)) return false;
    registerVariableDeclaration(node, scope, tsModule);
    return true;
  },
  (node, scope, tsModule) => {
    if (!tsModule.isFunctionDeclaration(node) || node.name === undefined)
      return false;
    registerBinding(scope, node.name);
    return true;
  },
  (node, scope, tsModule) => {
    if (!tsModule.isClassDeclaration(node) || node.name === undefined)
      return false;
    registerBinding(scope, node.name);
    return true;
  },
  (node, scope, tsModule) => {
    if (!tsModule.isEnumDeclaration(node)) return false;
    registerBinding(scope, node.name);
    return true;
  },
  (node, scope, tsModule) => {
    if (!tsModule.isImportDeclaration(node)) return false;
    registerImportBindings(node, scope, tsModule);
    return true;
  },
  (node, scope, tsModule) => {
    if (!tsModule.isImportEqualsDeclaration(node) || node.isTypeOnly)
      return false;
    registerBinding(scope, node.name);
    return true;
  },
];

export function registerDeclaration(
  node: ts.Node,
  scope: LexicalScope,
  tsModule: typeof ts,
): void {
  for (const register of declarationRegistrars) {
    if (register(node, scope, tsModule)) return;
  }
}
