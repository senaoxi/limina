import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import type {
  ImportRecord,
  ImportRecordKind,
} from '../import-analysis/records';

/**
Decorate a compiler-inventoried literal; this does not discover requests.
*/
export function compilerModuleRecord(
  source: ts.SourceFile,
  literal: ts.StringLiteralLike,
  role: 'import' | 'augmentation',
  compiler: typeof ts,
): ImportRecord {
  const start = literal.pos < 0 ? -1 : literal.getStart(source);
  return {
    domain: 'typescript',
    filePath: normalizeAbsolutePath(source.fileName),
    kind:
      role === 'augmentation'
        ? 'module-augmentation'
        : literalKind(literal, compiler),
    line: start < 0 ? 1 : source.getLineAndCharacterOfPosition(start).line + 1,
    locator: { sourceStart: start, sourceEnd: literal.end, occurrence: 0 },
    specifier: literal.text,
  };
}
function literalKind(
  literal: ts.StringLiteralLike,
  compiler: typeof ts,
): ImportRecordKind {
  if (literal.pos < 0) return 'environment-pragma';
  const parent = literal.parent;
  if (compiler.isCallExpression(parent))
    return parent.expression.kind === compiler.SyntaxKind.ImportKeyword
      ? 'dynamic'
      : 'commonjs';
  const kinds = new Map<number, ImportRecordKind>([
    [compiler.SyntaxKind.ImportDeclaration, 'static'],
    [compiler.SyntaxKind.ExportDeclaration, 'export'],
    [compiler.SyntaxKind.ExternalModuleReference, 'import-equals'],
    [compiler.SyntaxKind.LiteralType, 'import-type'],
    [compiler.SyntaxKind.JSDocImportTag, 'jsdoc-import'],
  ]);
  return kinds.get(parent.kind) ?? 'static';
}
