import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type {
  FrameworkSemanticCandidate,
  PreparedDependencyFact,
} from '../core/framework-semantic/contracts';
import {
  canonicalTypeEvidenceIdentity,
  prepareResolvedFrameworkCandidates,
} from '../core/framework-semantic/prepared-dependency';
import type {
  ImportRecord,
  ImportRecordKind,
} from '../core/import-analysis/runner';

function createSourceRecord(kind: ImportRecordKind = 'static'): ImportRecord {
  return {
    domain: 'vue-script',
    filePath: '/source/App.vue',
    kind,
    line: 3,
    locator: { occurrence: 0, sourceEnd: 30, sourceStart: 18 },
    specifier: './source-spelling.ts',
  };
}

function createCandidate(options: {
  generatedFilePath: string;
  kind?: ImportRecordKind;
  semanticSpecifier?: string;
}): FrameworkSemanticCandidate<ts.SourceFile, ts.StringLiteralLike> {
  const semanticSpecifier = options.semanticSpecifier ?? './target.js';
  const sourceFile = ts.createSourceFile(
    options.generatedFilePath,
    `import '${semanticSpecifier}';`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const statement = sourceFile.statements[0];
  if (statement === undefined || !ts.isImportDeclaration(statement)) {
    throw new Error('Expected an import declaration.');
  }
  return {
    containingSourceFile: sourceFile,
    framework: 'vue',
    identityId: options.generatedFilePath,
    literal: statement.moduleSpecifier as ts.StringLiteralLike,
    provenance: 'strict-source-map',
    semanticSpecifier,
    sourceRecord: createSourceRecord(options.kind),
  };
}

function createTarget(
  resolvedBy: 'checker-source' | 'typescript' = 'checker-source',
) {
  return {
    isExternalLibraryImport: false,
    resolvedBy,
    resolvedFileName: '/source/target.ts',
  } as const;
}

function prepare(
  resolved: Parameters<
    typeof prepareResolvedFrameworkCandidates
  >[0]['resolved'],
  program?: ts.Program,
) {
  return prepareResolvedFrameworkCandidates({
    checkerName: 'vue-tsc',
    framework: 'vue',
    program,
    resolved,
    tsModule: ts,
  });
}

describe('prepared framework dependency canonical merge', () => {
  it('deduplicates equivalent facts from multiple service scripts', () => {
    const result = prepare([
      {
        candidate: createCandidate({ generatedFilePath: '/generated/a.ts' }),
        resolutionMode: 'import',
        target: createTarget(),
      },
      {
        candidate: createCandidate({ generatedFilePath: '/generated/b.ts' }),
        resolutionMode: 'import',
        target: createTarget(),
      },
    ]);

    expect(result).toMatchObject({
      kind: 'supported',
      facts: [{ framework: 'vue' }],
    });
    if (result.kind === 'supported') expect(result.facts).toHaveLength(1);
  });

  it.each([
    {
      label: 'resolvedBy disagreement',
      second: {
        candidate: createCandidate({ generatedFilePath: '/generated/b.ts' }),
        resolutionMode: 'import',
        target: createTarget('typescript'),
      },
    },
    {
      label: 'dependency kind disagreement',
      second: {
        candidate: createCandidate({
          generatedFilePath: '/generated/b.ts',
          kind: 'dynamic',
        }),
        resolutionMode: 'import',
        target: createTarget(),
      },
    },
  ])('fails closed for $label on one source occurrence', ({ second }) => {
    const result = prepare([
      {
        candidate: createCandidate({ generatedFilePath: '/generated/a.ts' }),
        resolutionMode: 'import',
        target: createTarget(),
      },
      second,
    ]);

    expect(result).toMatchObject({
      kind: 'unsupported',
      stage: 'source-map-mismatch',
    });
  });

  it('fails closed when canonical ambient evidence disagrees', () => {
    const first = createCandidate({
      generatedFilePath: '/generated/a.ts',
      semanticSpecifier: './theme.css',
    });
    const second = createCandidate({
      generatedFilePath: '/generated/b.ts',
      semanticSpecifier: './theme.css',
    });
    const wildcard = ts.createSourceFile(
      '/types/wildcard.d.ts',
      "declare module '*.css' {}",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    ).statements[0]!;
    const exact = ts.createSourceFile(
      '/types/exact.d.ts',
      "declare module './theme.css' {}",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    ).statements[0]!;
    const sourceFiles = new Map([
      [
        path.normalize(first.containingSourceFile.fileName),
        first.containingSourceFile,
      ],
      [
        path.normalize(second.containingSourceFile.fileName),
        second.containingSourceFile,
      ],
    ]);
    const program = {
      getSourceFile: (fileName: string) =>
        sourceFiles.get(path.normalize(fileName)),
      getTypeChecker: () => ({
        getSymbolAtLocation: (literal: ts.Node) => ({
          declarations: [
            literal.getSourceFile().fileName ===
            first.containingSourceFile.fileName
              ? wildcard
              : exact,
          ],
        }),
      }),
    } as unknown as ts.Program;

    const result = prepare(
      [
        { candidate: first, resolutionMode: 'import', target: null },
        { candidate: second, resolutionMode: 'import', target: null },
      ],
      program,
    );

    expect(result).toMatchObject({
      kind: 'unsupported',
      stage: 'source-map-mismatch',
    });
  });

  it('canonicalizes ambient paths and complete managed-source identity', () => {
    const ambient: PreparedDependencyFact['typeEvidence'] = {
      declarationFilePaths: ['/types/z.d.ts', '/types/a.d.ts'],
      kind: 'ambient',
      modulePattern: '*.css',
    };
    const reversed = {
      ...ambient,
      declarationFilePaths: ambient.declarationFilePaths.toReversed(),
    } as typeof ambient;
    expect(canonicalTypeEvidenceIdentity(ambient)).toBe(
      canonicalTypeEvidenceIdentity(reversed),
    );

    const declaration: PreparedDependencyFact['typeEvidence'] = {
      filePath: '/types/generated.d.ts',
      kind: 'concrete-declaration',
      managedSource: {
        checkerNames: ['vue-tsc', 'tsc'],
        declarationFilePath: '/types/generated.d.ts',
        mappedSourceFilePath: '/source/generated.ts',
        reason: 'owned-source',
        sourceConfigPath: '/source/tsconfig.json',
      },
    };
    const changed = {
      ...declaration,
      managedSource: {
        ...declaration.managedSource!,
        mappedSourceFilePath: '/source/other.ts',
      },
    } as typeof declaration;
    expect(canonicalTypeEvidenceIdentity(declaration)).not.toBe(
      canonicalTypeEvidenceIdentity(changed),
    );
  });

  it('turns missing Program support into a structured compatibility failure', () => {
    const result = prepare([
      {
        candidate: createCandidate({ generatedFilePath: '/generated/a.ts' }),
        resolutionMode: 'import',
        target: null,
      },
    ]);

    expect(result).toMatchObject({
      kind: 'unsupported',
      stage: 'toolchain-compatibility',
    });
  });
});
