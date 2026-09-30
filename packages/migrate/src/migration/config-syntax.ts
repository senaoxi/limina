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
  return statement.moduleSpecifier.text === 'limina'
    ? namesFromClause(statement.importClause)
    : [];
}

function namesFromClause(clause: ts.ImportClause | undefined): string[] {
  return namedImports(clause?.namedBindings);
}

function namedImports(bindings: ts.NamedImportBindings | undefined): string[] {
  if (!bindings) return [];
  return ts.isNamedImports(bindings)
    ? bindings.elements
        .filter(isDefineConfigImport)
        .map((item) => item.name.text)
    : [];
}

function immutableDefinitions(
  statement: ts.VariableStatement,
): readonly ts.VariableDeclaration[] {
  return statement.declarationList.flags & ts.NodeFlags.Const
    ? statement.declarationList.declarations
    : [];
}

function uniqueInitializer(
  declaration: ts.VariableDeclaration,
  uses: ReadonlyMap<string, number>,
): [string, ts.Expression] | undefined {
  if (!ts.isIdentifier(declaration.name)) return undefined;
  return uses.get(declaration.name.text) === 2
    ? initializedDeclaration(declaration.name.text, declaration.initializer)
    : undefined;
}

function initializedDeclaration(
  name: string,
  value: ts.Expression | undefined,
): [string, ts.Expression] | undefined {
  return value ? [name, value] : undefined;
}

function isTransparentExpression(
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
  return assignments[0]!.isExportEquals
    ? unsupportedConfigEdit()
    : assignments[0]!.expression;
}

export class StaticConfigSyntax {
  private readonly definitions = new Map<string, ts.Expression>();

  private readonly defineNames = new Set<string>();

  readonly source: ts.SourceFile;

  readonly text: string;

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
    return this.defineNames.has(expression.expression.text)
      ? this.resolveDefineCall(expression, seen)
      : expression;
  }

  private resolveDefineCall(
    expression: ts.CallExpression,
    seen: Set<string>,
  ): ts.Expression {
    return expression.arguments.length === 1
      ? this.resolve(expression.arguments[0]!, seen)
      : unsupportedConfigEdit();
  }

  private resolveNamedExpression(
    expression: ts.Expression,
    seen: Set<string>,
  ): ts.Expression {
    if (ts.isIdentifier(expression))
      return this.resolveIdentifier(expression, seen);
    return ts.isCallExpression(expression)
      ? this.resolveCall(expression, seen)
      : expression;
  }

  private staticProperty(
    item: ts.ObjectLiteralElementLike,
  ): ts.PropertyAssignment {
    if (!ts.isPropertyAssignment(item)) return unsupportedConfigEdit();
    return ts.isComputedPropertyName(item.name)
      ? unsupportedConfigEdit()
      : item;
  }

  private insertionPosition(
    container: ts.Node,
    elements: readonly ts.Node[],
  ): number {
    return elements.at(-1)?.end ?? container.getStart(this.source) + 1;
  }

  resolve(
    expression: ts.Expression,
    seen: Set<string> = new Set<string>(),
  ): ts.Expression {
    return isTransparentExpression(expression)
      ? this.resolve(expression.expression, seen)
      : this.resolveNamedExpression(expression, seen);
  }

  root(): ts.ObjectLiteralExpression {
    return this.object(this.resolve(defaultExport(this.source)));
  }

  object(expression: ts.Expression): ts.ObjectLiteralExpression {
    return ts.isObjectLiteralExpression(expression)
      ? expression
      : unsupportedConfigEdit();
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
    return matches.length > 1 ? unsupportedConfigEdit() : matches[0];
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
