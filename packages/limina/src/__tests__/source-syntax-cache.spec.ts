import { createAnalysisProviders } from '#core';
import { normalizeAbsolutePath } from '#utils/path';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { collectTypeScriptSourceFileImports } from '../core/import-analysis/typescript-imports';
import { createWorkspaceSourceBoundary } from '../core/typescript-semantic';
import {
  BoundedTypeScriptSemanticContext,
  createBoundedTypeScriptSemanticContext,
} from '../core/typescript-semantic/context';
import { SourceSyntaxFactsCache } from '../core/typescript-semantic/syntax-cache';
import { OwnedSyntaxScope } from '../core/typescript-semantic/syntax-input';

const roots: string[] = [];
async function fixture(text = "import 'alpha';", ext = 'ts') {
  const root = await mkdtemp(path.join(tmpdir(), 'limina-syntax-'));
  roots.push(root);
  const file = normalizeAbsolutePath(path.join(root, `input.${ext}`));
  await writeFile(file, text);
  const project = {
    configPath: normalizeAbsolutePath(path.join(root, 'tsconfig.json')),
    fileNames: [file],
    options: {
      noLib: true,
      types: [],
      allowJs: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    },
    workspaceSourceBoundary: createWorkspaceSourceBoundary([file]),
  };
  return { root, file, project };
}
function read(
  project: Parameters<typeof createBoundedTypeScriptSemanticContext>[0],
  cache?: SourceSyntaxFactsCache,
) {
  const context = createBoundedTypeScriptSemanticContext(project, {
    syntaxFacts: cache,
  });
  try {
    return project.fileNames.map((file) => ({
      records: context.getImportRecords(file),
      facts: context
        .getImportRecords(file)
        .map((record) => context.getDependencyFact(record)),
      parents: context
        .getSourceFile(file)
        ?.statements.every(
          (statement) => statement.parent === context.getSourceFile(file),
        ),
    }));
  } finally {
    context.dispose();
  }
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('provider-owned raw syntax facts', () => {
  it('isolates ordered records, content changes, parents and per-context evidence', async () => {
    const f = await fixture(
      "/// <reference path='./ambient.d.ts'/>\nimport 'a'; import 'a';",
    );
    await writeFile(
      path.join(f.root, 'ambient.d.ts'),
      "declare module 'a' { export const a: 1 }",
    );
    const cache = new SourceSyntaxFactsCache();
    const oracle = read(f.project);
    const first = read(f.project, cache);
    expect(first).toEqual(oracle);
    expect(read(f.project, cache)).toEqual(oracle);
    expect(cache.statistics.hit).toBeGreaterThan(0);
    first[0].records[0].specifier = 'consumer mutation';
    first[0].records[0].locator.sourceStart = 123;
    expect(read(f.project, cache)).toEqual(oracle);
    const entries = cache.statistics.entries;
    await writeFile(f.file, "import 'changed';");
    expect(read(f.project, cache)).toEqual(read(f.project));
    expect(cache.statistics.entries).toBe(entries);
    cache.dispose();
    expect(cache.statistics.estimatedBytes).toBe(0);
    expect(cache.statistics.entries).toBe(0);
    expect(read(f.project, cache)).toEqual(read(f.project));
    expect(cache.statistics.entries).toBe(0);
  });

  it('evicts by budget and bypasses oversized inputs without losing facts', async () => {
    const a = await fixture("import 'a';");
    const b = await fixture("import 'b';");
    const probe = new SourceSyntaxFactsCache();
    read(a.project, probe);
    const size = probe.statistics.estimatedBytes;
    const cache = new SourceSyntaxFactsCache({ budget: size + 10 });
    read(a.project, cache);
    read(b.project, cache);
    expect(cache.statistics.eviction).toBe(1);
    expect(cache.statistics.entries).toBe(1);
    const miss = cache.statistics.miss;
    read(a.project, cache);
    expect(cache.statistics.miss).toBe(miss + 1);
    const small = new SourceSyntaxFactsCache({ entryLimit: 1 });
    expect(read(a.project, small)).toEqual(read(a.project));
    expect(small.statistics.entries).toBe(0);
    expect(small.statistics.bypass).toBeGreaterThan(0);
  });

  it('bypasses foreign compilers and malformed syntax', async () => {
    const f = await fixture("import 'a';");
    const cache = new SourceSyntaxFactsCache();
    const foreign = { ...ts };
    const context = new BoundedTypeScriptSemanticContext(f.project, foreign, {
      syntaxFacts: cache,
    });
    expect(context.getImportRecords(f.file)).toEqual(
      read(f.project)[0].records,
    );
    context.dispose();
    expect(cache.statistics.entries).toBe(0);
    await writeFile(f.file, "import { from 'a';");
    expect(read(f.project, cache)).toEqual(read(f.project));
    expect(cache.statistics.entries).toBe(0);
  });

  it('keeps foreign, mutable and framework ASTs on the original collector', () => {
    for (const suffix of ['ts', 'vue', 'astro', 'svelte']) {
      const name = `/virtual/foreign.${suffix}`;
      const sf = ts.createSourceFile(
        name,
        "import 'first';",
        ts.ScriptTarget.Latest,
        true,
      );
      const scope = new OwnedSyntaxScope({}, ts);
      expect(
        scope.capture(sf, {
          languageVersion: ts.ScriptTarget.Latest,
          setExternalModuleIndicator: (file) => {
            (
              file as ts.SourceFile & { externalModuleIndicator?: true }
            ).externalModuleIndicator = true;
          },
        }),
      ).toBeUndefined();
      const options = { sourceFile: sf, filePath: name, tsModule: ts };
      expect(collectTypeScriptSourceFileImports(options)[0].specifier).toBe(
        'first',
      );
      (
        (sf.statements[0] as ts.ImportDeclaration)
          .moduleSpecifier as ts.StringLiteral & { text: string }
      ).text = 'changed';
      // Text and AST can disagree: this path deliberately does not memoize.
      expect(collectTypeScriptSourceFileImports(options)[0].specifier).toBe(
        'changed',
      );
    }
  });

  it('keeps lexical aliases distinct and providers isolated at the same generation', async () => {
    const f = await fixture();
    const alias = normalizeAbsolutePath(path.join(f.root, 'alias.ts'));
    await symlink(f.file, alias);
    const cache = new SourceSyntaxFactsCache();
    read(f.project, cache);
    read(
      {
        ...f.project,
        fileNames: [alias],
        workspaceSourceBoundary: createWorkspaceSourceBoundary([alias]),
      },
      cache,
    );
    expect(cache.statistics.entries).toBe(2);
    const config = {
      configPath: normalizeAbsolutePath(path.join(f.root, 'limina.config.mjs')),
      rootDir: f.root,
    };
    const first = createAnalysisProviders(config);
    const second = createAnalysisProviders(config);
    expect(first.artifactNamespace.generation).toBe(
      second.artifactNamespace.generation,
    );
    expect(first.syntaxFacts).not.toBe(second.syntaxFacts);
    read(f.project, first.syntaxFacts);
    expect(second.syntaxFacts.statistics.entries).toBe(0);
    first.dispose();
    second.dispose();
    expect(first.syntaxFacts.statistics.entries).toBe(0);
  });
});
