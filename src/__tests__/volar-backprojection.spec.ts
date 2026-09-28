import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { GeneratedSemanticDependency } from '../core/framework-semantic/generated-dependencies';
import { strictBackprojectVolarDependency } from '../core/framework-semantic/volar-backprojection';

function createDependency(): GeneratedSemanticDependency {
  const sourceFile = ts.createSourceFile(
    '/generated/App.vue.ts',
    "import './dep';",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const statement = sourceFile.statements[0];
  if (statement === undefined || !ts.isImportDeclaration(statement)) {
    throw new Error('Expected an import declaration.');
  }
  return {
    generatedFilePath: sourceFile.fileName,
    literal: statement.moduleSpecifier as ts.StringLiteral,
    record: {
      domain: 'typescript',
      filePath: sourceFile.fileName,
      kind: 'static',
      line: 1,
      locator: { occurrence: 0, sourceEnd: 14, sourceStart: 7 },
      specifier: './dep',
    },
    sourceFile,
  };
}

function project(
  toSourceRange: (
    start: number,
    end: number,
    fallbackToAnyMatch: boolean,
  ) => Iterable<readonly [number, number, unknown, unknown]>,
) {
  return strictBackprojectVolarDependency({
    dependency: createDependency(),
    mapper: { toSourceRange },
    sourceFilePath: '/source/App.vue',
    sourceText: '<script>\nimport "./dep";\n</script>\n',
  });
}

describe('strict Volar backprojection', () => {
  it('uses a successful full-token projection without unioning inner content', () => {
    const toSourceRange = vi.fn(function* (start: number, end: number) {
      expect([start, end]).toEqual([7, 14]);
      yield [16, 23, undefined, undefined] as const;
    });

    expect(project(toSourceRange)).toMatchObject({ kind: 'mapped' });
    expect(toSourceRange).toHaveBeenCalledTimes(1);
    expect(toSourceRange).toHaveBeenCalledWith(7, 14, false);
  });

  it('falls back to inner content only after the full token is unmapped', () => {
    const toSourceRange = vi.fn(function* (start: number, end: number) {
      if (start === 8 && end === 13) {
        yield [17, 22, undefined, undefined] as const;
      }
    });

    expect(project(toSourceRange)).toMatchObject({ kind: 'mapped' });
    expect(toSourceRange.mock.calls).toEqual([
      [7, 14, false],
      [8, 13, false],
    ]);
  });

  it('reports ambiguity only within the selected strict attempt', () => {
    expect(
      project(function* () {
        yield [16, 23, undefined, undefined] as const;
        yield [24, 31, undefined, undefined] as const;
      }),
    ).toEqual({ kind: 'source-map-ambiguity' });
  });

  it('keeps a dependency synthetic when both strict attempts are unmapped', () => {
    expect(project(function* () {})).toEqual({ kind: 'unmapped' });
  });

  it('fails closed for a damaged source range after mapping evidence exists', () => {
    expect(
      project(function* () {
        yield [17, 999, undefined, undefined] as const;
      }),
    ).toMatchObject({ kind: 'source-map-mismatch' });
  });
});
