import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'pathe';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { collectStronglyConnectedComponents } from '../utils/strongly-connected-components';
import { toPortablePath } from './helpers/path';

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));

async function collectProductionSourceFiles(
  directory = sourceRoot,
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return entry.name === '__tests__'
          ? []
          : collectProductionSourceFiles(entryPath);
      }
      return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
    }),
  );
  return files.flat();
}

function getImportedLocalNames(
  sourceFile: ts.SourceFile,
  importedName: string,
): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === importedName) {
        names.add(element.name.text);
      }
    }
  }
  return names;
}

function isCallsAnyLocalName(
  sourceFile: ts.SourceFile,
  localNames: ReadonlySet<string>,
): boolean {
  let isFound = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      localNames.has(node.expression.text)
    ) {
      isFound = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return isFound;
}

async function findProductionCallers(importedName: string): Promise<string[]> {
  const callers: string[] = [];
  const directoryEntries1 = await collectProductionSourceFiles();
  for (const filePath of directoryEntries1) {
    const source = await readFile(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const localNames = getImportedLocalNames(sourceFile, importedName);
    if (localNames.size > 0 && isCallsAnyLocalName(sourceFile, localNames)) {
      callers.push(toPortablePath(path.relative(sourceRoot, filePath)));
    }
  }
  return callers.sort(
    (left, right) => Number(left > right) - Number(left < right),
  );
}

function hasRuntimeImport(importDeclaration: ts.ImportDeclaration): boolean {
  const clause = importDeclaration.importClause;
  if (clause === undefined) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name !== undefined) return true;
  const bindings = clause.namedBindings;
  return (
    bindings === undefined ||
    ts.isNamespaceImport(bindings) ||
    bindings.elements.some((element) => !element.isTypeOnly)
  );
}

function getRuntimeRelativeSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      hasRuntimeImport(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers.filter((specifier) => specifier.startsWith('.'));
}

function resolveRelativeProductionImport(
  importer: string,
  specifier: string,
  productionFiles: ReadonlySet<string>,
): string | undefined {
  const basePath = path.resolve(path.dirname(importer), specifier);
  return [`${basePath}.ts`, path.join(basePath, 'index.ts')].find((candidate) =>
    productionFiles.has(candidate),
  );
}

async function collectRuntimeImportCycles(): Promise<string[][]> {
  const files = await collectProductionSourceFiles();
  const productionFiles = new Set(files);
  const neighbors = new Map<string, string[]>();
  for (const filePath of files) {
    const sourceFile = ts.createSourceFile(
      filePath,
      await readFile(filePath, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    neighbors.set(
      filePath,
      getRuntimeRelativeSpecifiers(sourceFile)
        .map((specifier) =>
          resolveRelativeProductionImport(filePath, specifier, productionFiles),
        )
        .filter((target): target is string => target !== undefined),
    );
  }
  return collectStronglyConnectedComponents(
    files,
    (filePath) => neighbors.get(filePath) ?? [],
  )
    .filter((component) => component.length > 1)
    .map((component) =>
      component.map((filePath) =>
        toPortablePath(path.relative(sourceRoot, filePath)),
      ),
    );
}

describe('production architecture boundaries', () => {
  it('keeps the relative runtime import graph acyclic', async () => {
    await expect(collectRuntimeImportCycles()).resolves.toEqual([]);
  });

  it('keeps generated artifact application at the preflight manager boundary', async () => {
    await expect(
      findProductionCallers('materializeGeneratedArtifactPlan'),
    ).resolves.toEqual(['preflight/materialization.ts']);
    await expect(
      findProductionCallers('ensurePreflightGraphMaterialized'),
    ).resolves.toEqual(['preflight/manager.ts']);
  });

  it('keeps generation advancement private to the execution scheduler', async () => {
    await expect(
      findProductionCallers('createPreflightGenerationController'),
    ).resolves.toEqual(['execution/executor.ts']);

    for (const barrel of ['index.ts', 'preflight/index.ts']) {
      const source = await readFile(path.join(sourceRoot, barrel), 'utf8');
      expect(source).not.toContain("'./generation'");
      expect(source).not.toContain("'./preflight/generation'");
    }
  });

  it('does not introduce a preflight to execution dependency', async () => {
    const preflightRoot = path.join(sourceRoot, 'preflight');
    const directoryEntries2 = await collectProductionSourceFiles(preflightRoot);
    for (const filePath of directoryEntries2) {
      const sourceFile = ts.createSourceFile(
        filePath,
        await readFile(filePath, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const executionImports = sourceFile.statements.filter(
        (statement): statement is ts.ImportDeclaration =>
          ts.isImportDeclaration(statement) &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          /(?:^|\/)execution(?:\/|$)/u.test(statement.moduleSpecifier.text),
      );
      expect(executionImports, filePath).toHaveLength(0);
    }
  });
});
