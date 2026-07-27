import { normalizeAbsolutePath } from '#utils/path';
import ts from 'typescript';
import type { TypeEvidence } from './cache';

type StringNamedModuleDeclaration = ts.ModuleDeclaration & {
  name: ts.StringLiteral;
};

function isStringNamedModuleDeclaration(
  declaration: ts.Declaration,
): declaration is StringNamedModuleDeclaration {
  if (!ts.isModuleDeclaration(declaration)) {
    return false;
  }

  return ts.isStringLiteral(declaration.name);
}

function collectAmbientDeclarations(
  symbol: ts.Symbol,
): StringNamedModuleDeclaration[] {
  return (symbol.declarations ?? []).filter(isStringNamedModuleDeclaration);
}

function collectDeclarationFilePaths(
  declarations: readonly ts.ModuleDeclaration[],
): string[] {
  return [
    ...new Set(
      declarations.map((declaration) =>
        normalizeAbsolutePath(declaration.getSourceFile().fileName),
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

export function createAmbientTypeEvidence(symbol: ts.Symbol): TypeEvidence {
  const declarations = collectAmbientDeclarations(symbol);
  const modulePatterns = [
    ...new Set(declarations.map((declaration) => declaration.name.text)),
  ];

  if (modulePatterns.length !== 1 || declarations.length === 0) {
    return { kind: 'missing' };
  }

  return {
    declarationFilePaths: collectDeclarationFilePaths(declarations),
    kind: 'ambient',
    modulePattern: modulePatterns[0]!,
  };
}
