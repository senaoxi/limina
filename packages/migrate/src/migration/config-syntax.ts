import ts from 'typescript';
import { MigrationInputError } from './declarations';

export function unsupportedConfigEdit(): never {
  throw new MigrationInputError(
    'Cannot persist exact tsconfig exclusions: the exported config or regions.exclude is not a uniquely editable static object/array. The original module is preserved; input adoption remains incomplete.',
  );
}

function countIdentifiers(source: ts.SourceFile): Map<string, number> {
  const uses = new Map<string, number>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node))
      uses.set(node.text, (uses.get(node.text) ?? 0) + 1);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return uses;
}

function isDefineConfigImport(item: ts.ImportSpecifier): boolean {
  return (item.propertyName ?? item.name).text === 'defineConfig';
}

function importedDefineNames(statement: ts.ImportDeclaration): string[] {
  if (!ts.isStringLiteral(statement.moduleSpecifier)) return [];
  if (statement.moduleSpecifier.text !== 'limina') return [];
  return namesFromClause(statement.importClause);
}

function namesFromClause(clause: ts.ImportClause | undefined): string[] {
  return namedImports(clause?.namedBindings);
}

function namedImports(bindings: ts.NamedImportBindings | undefined): string[] {
  if (!bindings) return [];
  if (!ts.isNamedImports(bindings)) return [];
  return bindings.elements
    .filter(isDefineConfigImport)
    .map((item) => item.name.text);
}

function immutableDefinitions(
  statement: ts.VariableStatement,
): readonly ts.VariableDeclaration[] {
  if (!(statement.declarationList.flags & ts.NodeFlags.Const)) return [];
  return statement.declarationList.declarations;
}

function uniqueInitializer(
  declaration: ts.VariableDeclaration,
  uses: ReadonlyMap<string, number>,
): [string, ts.Expression] | undefined {
  if (!ts.isIdentifier(declaration.name)) return undefined;
  if (uses.get(declaration.name.text) !== 2) return undefined;
  return initializedDeclaration(declaration.name.text, declaration.initializer);
}

function initializedDeclaration(
  name: string,
  value: ts.Expression | undefined,
): [string, ts.Expression] | undefined {
  return value ? [name, value] : undefined;
}

function transparentExpression(
  expression: ts.Expression,
): expression is
  | ts.ParenthesizedExpression
  | ts.AsExpression
  | ts.SatisfiesExpression {
  return [
    ts.isParenthesizedExpression,
    ts.isAsExpression,
    ts.isSatisfiesExpression,
  ].some((test) => test(expression));
}

function defaultExport(source: ts.SourceFile): ts.Expression {
  const assignments = source.statements.filter(ts.isExportAssignment);
  if (assignments.length !== 1) return unsupportedConfigEdit();
  if (assignments[0]!.isExportEquals) return unsupportedConfigEdit();
  return assignments[0]!.expression;
}

export class StaticConfigSyntax {
  readonly source: ts.SourceFile;
  readonly text: string;
  private readonly definitions = new Map<string, ts.Expression>();
  private readonly defineNames = new Set<string>();

  constructor(fileName: string, text: string) {
    this.text = text;
    this.source = ts.createSourceFile(
      fileName,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const uses = countIdentifiers(this.source);
    for (const statement of this.source.statements)
      this.collectStatement(statement, uses);
  }

  private collectStatement(
    statement: ts.Statement,
    uses: ReadonlyMap<string, number>,
  ): void {
    if (ts.isImportDeclaration(statement)) this.collectImport(statement);
    if (ts.isVariableStatement(statement))
      this.collectDefinitions(immutableDefinitions(statement), uses);
  }

  private collectImport(statement: ts.ImportDeclaration): void {
    for (const name of importedDefineNames(statement))
      this.defineNames.add(name);
  }

  private collectDefinitions(
    declarations: readonly ts.VariableDeclaration[],
    uses: ReadonlyMap<string, number>,
  ): void {
    for (const declaration of declarations) {
      const entry = uniqueInitializer(declaration, uses);
      if (entry) this.definitions.set(...entry);
    }
  }

  private resolveIdentifier(
    expression: ts.Identifier,
    seen: Set<string>,
  ): ts.Expression {
    const initializer = this.definitions.get(expression.text);
    if (!initializer) return unsupportedConfigEdit();
    if (seen.has(expression.text)) return unsupportedConfigEdit();
    seen.add(expression.text);
    return this.resolve(initializer, seen);
  }

  private resolveCall(
    expression: ts.CallExpression,
    seen: Set<string>,
  ): ts.Expression {
    if (!ts.isIdentifier(expression.expression)) return expression;
    if (!this.defineNames.has(expression.expression.text)) return expression;
    return this.resolveDefineCall(expression, seen);
  }

  private resolveDefineCall(
    expression: ts.CallExpression,
    seen: Set<string>,
  ): ts.Expression {
    if (expression.arguments.length !== 1) return unsupportedConfigEdit();
    return this.resolve(expression.arguments[0]!, seen);
  }

  resolve(
    expression: ts.Expression,
    seen: Set<string> = new Set<string>(),
  ): ts.Expression {
    if (transparentExpression(expression))
      return this.resolve(expression.expression, seen);
    return this.resolveNamedExpression(expression, seen);
  }

  private resolveNamedExpression(
    expression: ts.Expression,
    seen: Set<string>,
  ): ts.Expression {
    if (ts.isIdentifier(expression))
      return this.resolveIdentifier(expression, seen);
    if (ts.isCallExpression(expression))
      return this.resolveCall(expression, seen);
    return expression;
  }

  root(): ts.ObjectLiteralExpression {
    return this.object(this.resolve(defaultExport(this.source)));
  }

  object(expression: ts.Expression): ts.ObjectLiteralExpression {
    if (!ts.isObjectLiteralExpression(expression))
      return unsupportedConfigEdit();
    return expression;
  }

  private staticProperty(
    item: ts.ObjectLiteralElementLike,
  ): ts.PropertyAssignment {
    if (!ts.isPropertyAssignment(item)) return unsupportedConfigEdit();
    if (ts.isComputedPropertyName(item.name)) return unsupportedConfigEdit();
    return item;
  }

  property(
    object: ts.ObjectLiteralExpression,
    name: string,
  ): ts.PropertyAssignment | undefined {
    const properties = object.properties.map((item) =>
      this.staticProperty(item),
    );
    const matches = properties.filter(
      (item) =>
        item.name.getText(this.source).replaceAll(/^['"]|['"]$/gu, '') === name,
    );
    if (matches.length > 1) return unsupportedConfigEdit();
    return matches[0];
  }

  private insertionPosition(
    container: ts.Node,
    elements: readonly ts.Node[],
  ): number {
    return elements.at(-1)?.end ?? container.getStart(this.source) + 1;
  }

  insert(
    container: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
    value: string,
  ): string {
    const elements = ts.isObjectLiteralExpression(container)
      ? container.properties
      : container.elements;
    const position = this.insertionPosition(container, elements);
    return `${this.text.slice(
      0,
      position,
    )}${elements.length > 0 ? ',' : ''}\n${value}${this.text.slice(position)}`;
  }
}
