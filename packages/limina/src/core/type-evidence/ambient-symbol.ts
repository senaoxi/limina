import { normalizeAbsolutePath } from '#utils/path';
import ts from 'typescript';
import type { TypeEvidence } from './cache';

type StringNamedModuleDeclaration = ts.ModuleDeclaration & {
  name: ts.StringLiteral;
};

function isStringNamedModuleDeclaration(
  declaration: ts.Declaration,
  tsModule: typeof ts,
): declaration is StringNamedModuleDeclaration {
  if (!tsModule.isModuleDeclaration(declaration)) {
    return false;
  }

  return tsModule.isStringLiteral(declaration.name);
}

function collectAmbientDeclarations(
  symbol: ts.Symbol,
  tsModule: typeof ts,
): StringNamedModuleDeclaration[] {
  return (symbol.declarations ?? []).filter((declaration) =>
    isStringNamedModuleDeclaration(declaration, tsModule),
  );
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

export function createAmbientTypeEvidence(
  symbol: ts.Symbol,
  tsModule: typeof ts = ts,
): TypeEvidence {
  const declarations = collectAmbientDeclarations(symbol, tsModule);
  const modulePatterns = [
    ...new Set(declarations.map((declaration) => declaration.name.text)),
  ];

  if (![modulePatterns.length === 1, declarations.length > 0].every(Boolean)) {
    return { kind: 'missing' };
  }

  return {
    declarationFilePaths: collectDeclarationFilePaths(declarations),
    kind: 'ambient',
    modulePattern: modulePatterns[0]!,
  };
}
