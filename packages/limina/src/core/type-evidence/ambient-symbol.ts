import { normalizeAbsolutePath } from '#utils/path';
import ts from 'typescript';
import type { TypeEvidence } from './cache';

export function createAmbientTypeEvidence(symbol: ts.Symbol): TypeEvidence {
  const declarations = (symbol.declarations ?? []).filter(
    (declaration): declaration is ts.ModuleDeclaration =>
      ts.isModuleDeclaration(declaration) &&
      ts.isStringLiteral(declaration.name),
  );
  const modulePatterns = [
    ...new Set(declarations.map((declaration) => declaration.name.text)),
  ];

  if (modulePatterns.length !== 1 || declarations.length === 0) {
    return { kind: 'missing' };
  }

  return {
    declarationFilePaths: [
      ...new Set(
        declarations.map((declaration) =>
          normalizeAbsolutePath(declaration.getSourceFile().fileName),
        ),
      ),
    ].sort((left, right) => left.localeCompare(right)),
    kind: 'ambient',
    modulePattern: modulePatterns[0]!,
  };
}
