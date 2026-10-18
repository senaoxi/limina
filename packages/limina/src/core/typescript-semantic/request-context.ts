import ts from 'typescript';
import type {
  DependencyRequestTemplate,
  FileDependencyFacts,
} from './file-dependency-facts';
import {
  bindFileModuleContext,
  type FileModuleContext,
  nativeRequestApi,
} from './native-request-api';

function exportStatement(): ts.Statement {
  return ts.factory.createExportDeclaration(
    undefined,
    false,
    ts.factory.createNamedExports([]),
  );
}
function jsxStatement(): ts.Statement {
  const element = ts.factory.createJsxSelfClosingElement(
    ts.factory.createIdentifier('DependencyProbe'),
    undefined,
    ts.factory.createJsxAttributes([]),
  );
  return ts.factory.createExpressionStatement(element);
}
function syntheticFile(
  facts: FileDependencyFacts,
  statements: ts.Statement[],
  moduleContext: FileModuleContext,
): ts.SourceFile {
  const file = ts.factory.createSourceFile(
    statements,
    ts.factory.createToken(ts.SyntaxKind.EndOfFileToken),
    ts.NodeFlags.None,
  );
  file.fileName = facts.filePath;
  file.isDeclarationFile = facts.declaration;
  bindFileModuleContext(file, moduleContext);
  return file;
}
export function isExternalDependencyFile(
  facts: FileDependencyFacts,
  options: ts.CompilerOptions,
  moduleContext: FileModuleContext,
): boolean {
  const statements: ts.Statement[] = [];
  if (facts.externalModule) statements.push(exportStatement());
  if (facts.containsJsx) statements.push(jsxStatement());
  const file = syntheticFile(facts, statements, moduleContext);
  nativeRequestApi.getSetExternalModuleIndicator(options)(file);
  return ts.isExternalModule(file);
}
function usageExpression(kind: string): ts.Expression {
  return kind === 'dynamic'
    ? (ts.factory.createToken(
        ts.SyntaxKind.ImportKeyword,
      ) as ts.ImportExpression)
    : ts.factory.createIdentifier('require');
}
function usageStatement(kind: string, literal: ts.StringLiteral): ts.Statement {
  if (
    !['dynamic', 'commonjs', 'require-resolve', 'import-equals'].includes(kind)
  )
    return ts.factory.createImportDeclaration(undefined, undefined, literal);
  const call = ts.factory.createCallExpression(
    usageExpression(kind),
    undefined,
    [literal],
  );
  return ts.factory.createExpressionStatement(call);
}
function attachParents(node: ts.Node): void {
  ts.forEachChild(node, (child) => {
    (child as { parent: ts.Node }).parent = node;
    attachParents(child);
  });
}
// Bind only a tiny synthetic usage node; never reparse an unchanged file.
export function requestResolutionMode(input: {
  facts: FileDependencyFacts;
  request: DependencyRequestTemplate;
  options: ts.CompilerOptions;
  moduleContext: FileModuleContext;
}): ts.ResolutionMode {
  if (input.request.explicitMode !== undefined)
    return input.request.explicitMode;
  return input.request.occurrence.kind === 'triple-slash-types'
    ? input.moduleContext.mode
    : usageMode(input);
}
function usageMode({
  facts,
  request,
  options,
  moduleContext,
}: Parameters<typeof requestResolutionMode>[0]): ts.ResolutionMode {
  const literal = ts.factory.createStringLiteral(request.occurrence.specifier);
  const file = syntheticFile(
    facts,
    [usageStatement(request.occurrence.kind, literal)],
    moduleContext,
  );
  attachParents(file);
  return ts.getModeForUsageLocation(file, literal, options);
}
