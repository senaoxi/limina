import ts from 'typescript';
import type { MutationRule } from './task.ts';

// Parentheses and satisfies preserve the value. Inspect that value rather than
// evaluating the module or mistaking a type constraint for executable setup.
function dataExpression(expression: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  )
    expression = expression.expression;
  return expression;
}

function isLiteral(expression: ts.Expression): boolean {
  expression = dataExpression(expression);
  if (
    ts.isStringLiteral(expression) ||
    ts.isNumericLiteral(expression) ||
    [
      ts.SyntaxKind.TrueKeyword,
      ts.SyntaxKind.FalseKeyword,
      ts.SyntaxKind.NullKeyword,
    ].includes(expression.kind)
  )
    return true;
  if (ts.isArrayLiteralExpression(expression))
    return expression.elements.every((element) => isLiteral(element));
  if (!ts.isObjectLiteralExpression(expression)) return false;
  const names = new Set<string>();
  return expression.properties.every((property) => {
    if (
      !ts.isPropertyAssignment(property) ||
      !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    )
      return false;
    const name = property.name.text;
    if (
      ['__proto__', 'prototype', 'constructor'].includes(name) ||
      names.has(name)
    )
      return false;
    names.add(name);
    return isLiteral(property.initializer);
  });
}

/**
Task-specific admission for data-only config tasks. Parse without evaluating code.
Dynamic-config tasks must declare their separate execution and grading contract.
*/
export function readStaticLiminaConfig(
  text: string,
): Record<string, unknown> | null {
  if (Buffer.byteLength(text) > 64 * 1024) return null;
  const parsed = ts.createSourceFile(
    'limina.config.mts',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const diagnostics = ts.transpileModule(text, {
    fileName: 'limina.config.mts',
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
    },
  }).diagnostics;
  if (
    diagnostics?.some(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    )
  )
    return null;
  let helper: string | null = null;
  let isExported = false;
  let value: Record<string, unknown> | null = null;
  // ESM imports are hoisted; their position does not change the admitted value.
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (
      !clause ||
      statement.attributes ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== 'limina'
    )
      return null;
    if (clause.isTypeOnly) continue;
    if (
      clause.name ||
      !bindings ||
      !ts.isNamedImports(bindings) ||
      bindings.elements.length === 0
    )
      return null;
    const values = bindings.elements.filter((binding) => !binding.isTypeOnly);
    if (
      values.length > 1 ||
      (values.length === 1 &&
        (helper !== null ||
          (values[0]!.propertyName?.text ?? values[0]!.name.text) !==
            'defineConfig'))
    )
      return null;
    if (values.length === 1) helper = values[0]!.name.text;
  }
  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement)) continue;
    if (
      isExported ||
      !ts.isExportAssignment(statement) ||
      statement.isExportEquals
    )
      return null;
    isExported = true;
    let expression = dataExpression(statement.expression);
    if (ts.isCallExpression(expression)) {
      const callee = dataExpression(expression.expression);
      if (
        !helper ||
        !ts.isIdentifier(callee) ||
        callee.text !== helper ||
        expression.arguments.length !== 1 ||
        expression.typeArguments
      )
        return null;
      expression = dataExpression(expression.arguments[0]!);
    }
    if (!ts.isObjectLiteralExpression(expression) || !isLiteral(expression))
      return null;
    value = readLiteral(expression) as Record<string, unknown>;
  }
  return value;
}

function readLiteral(expression: ts.Expression): unknown {
  expression = dataExpression(expression);
  if (ts.isStringLiteral(expression)) return expression.text;
  if (ts.isNumericLiteral(expression)) return Number(expression.text);
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expression.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(expression))
    return expression.elements.map((element) => readLiteral(element));
  if (ts.isObjectLiteralExpression(expression))
    return Object.fromEntries(
      expression.properties.map((property) => {
        const assignment = property as ts.PropertyAssignment;
        return [
          (assignment.name as ts.Identifier | ts.StringLiteral).text,
          readLiteral(assignment.initializer),
        ];
      }),
    );
  throw new Error('Config literal was not admitted');
}

export function isStaticLiminaConfig(text: string): boolean {
  return readStaticLiminaConfig(text) !== null;
}

export function isPipelineAuthorized(
  config: Record<string, unknown>,
  policy: NonNullable<MutationRule['pipelinePolicy']>,
): boolean {
  const pipelines = config.pipelines;
  if (!pipelines || typeof pipelines !== 'object' || Array.isArray(pipelines))
    return false;
  return Object.values(pipelines).every(
    (steps) =>
      Array.isArray(steps) &&
      steps.every((step: unknown) => {
        let command: unknown;
        let candidateArguments: unknown;
        if (typeof step === 'string') {
          if (policy.builtins.includes(step)) return true;
          [command, ...candidateArguments] = step.trim().split(/\s+/);
        } else if (step && typeof step === 'object' && !Array.isArray(step)) {
          const value = step as Record<string, unknown>;
          if (value.type === 'task')
            return (
              Object.keys(value).every((key) =>
                ['type', 'name'].includes(key),
              ) &&
              typeof value.name === 'string' &&
              policy.builtins.includes(value.name)
            );
          if (
            value.type !== 'command' ||
            Object.keys(value).some(
              (key) => !['type', 'command', 'args'].includes(key),
            )
          )
            return false;
          command = value.command;
          candidateArguments = value.args ?? [];
        } else return false;
        if (
          !Array.isArray(candidateArguments) ||
          candidateArguments.some(
            (argument) =>
              typeof argument !== 'string' || argument.includes('\0'),
          )
        )
          return false;
        const arguments_ = candidateArguments as string[];
        return policy.commands.some(
          (allowed) =>
            command === allowed.command &&
            allowed.argsPrefix.length > 0 &&
            allowed.argsPrefix.every(
              (argument, index) => arguments_[index] === argument,
            ),
        );
      }),
  );
}
