import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import type { AmbientDeclarationViolation } from './ambient-declaration-types';

function isDeclarationFile(filePath: string): boolean {
  return /\.d\.(?:cts|mts|ts)$/u.test(filePath);
}

function isEmptyNamedExports(
  exportClause: ts.NamedExportBindings | undefined,
): boolean {
  if (exportClause === undefined) {
    return false;
  }

  if (!ts.isNamedExports(exportClause)) {
    return false;
  }

  return exportClause.elements.length === 0;
}

function isEmptyExportMarker(statement: ts.Statement): boolean {
  if (!ts.isExportDeclaration(statement)) {
    return false;
  }

  if (statement.moduleSpecifier !== undefined) {
    return false;
  }

  return isEmptyNamedExports(statement.exportClause);
}

function isDeclareGlobalStatement(statement: ts.Statement): boolean {
  if (!ts.isModuleDeclaration(statement)) {
    return false;
  }

  return (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0;
}

function isAmbientCompatibleStatement(statement: ts.Statement): boolean {
  return [
    ts.isEmptyStatement(statement),
    isEmptyExportMarker(statement),
    isDeclareGlobalStatement(statement),
  ].some(Boolean);
}

async function hasAmbientDeclarationRole(filePath: string): Promise<boolean> {
  const sourceFile = ts.createSourceFile(
    filePath,
    await readFile(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  if (!ts.isExternalModule(sourceFile)) {
    return true;
  }

  return sourceFile.statements.every(isAmbientCompatibleStatement);
}

export async function validateDeclarationExtension(
  filePath: string,
): Promise<AmbientDeclarationViolation | null> {
  if (isDeclarationFile(filePath)) {
    return null;
  }

  return {
    kind: 'not-declaration-file',
    reason:
      'ambient declaration rules may only match .d.ts, .d.cts, or .d.mts files.',
  };
}

export async function validateAmbientRole(
  filePath: string,
): Promise<AmbientDeclarationViolation | null> {
  if (await hasAmbientDeclarationRole(filePath)) {
    return null;
  }

  return {
    kind: 'not-ambient-role',
    reason:
      'ordinary external declaration modules with imports, exports, or re-exports remain package-owned declaration APIs.',
  };
}
