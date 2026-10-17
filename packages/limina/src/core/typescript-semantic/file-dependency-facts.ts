import ts from 'typescript';
import type { ImportRecord } from '../import-analysis/records';
import {
  collectTypeScriptSourceFileImports,
  getSourceFileKind,
} from '../import-analysis/typescript-imports';
import { findImportRecordLiteral } from './import-record';
import {
  potentialAugmentations,
  requestEligibility,
} from './request-eligibility';

/**
No options, resolution result, redirect, AST or consumer identity lives here.
*/
export interface DependencyRequestTemplate {
  occurrence: ImportRecord;
  explicitMode?: ts.ResolutionMode;
  governance: boolean;
  expansion: boolean;
  externalModuleOnly?: boolean;
}
export interface FileDependencyFacts {
  version: 1;
  compilerVersion: string;
  filePath: string;
  sourceVersion: string;
  externalModule: boolean;
  declaration: boolean;
  containsJsx: boolean;
  noDefaultLib: boolean;
  jsxRuntime?: string;
  requests: DependencyRequestTemplate[];
  libraries: string[];
}

function attributesOf(
  node: ts.Node | undefined,
): ts.ImportAttributes | undefined {
  return node === undefined
    ? undefined
    : (declarationAttributes(node) ?? typeAttributes(node));
}
function declarationAttributes(node: ts.Node): ts.ImportAttributes | undefined {
  if (ts.isImportDeclaration(node)) return node.attributes;
  return ts.isExportDeclaration(node) ? node.attributes : undefined;
}
function typeAttributes(node: ts.Node): ts.ImportAttributes | undefined {
  if (!ts.isLiteralTypeNode(node)) return undefined;
  return ts.isImportTypeNode(node.parent) ? node.parent.attributes : undefined;
}
function explicitUsageMode(
  file: ts.SourceFile,
  literal: ts.StringLiteralLike | null,
): ts.ResolutionMode {
  if (literal === null) return undefined;
  const attributes = attributesOf(literal.parent);
  if (!hasResolutionMode(attributes)) return undefined;
  return ts.getModeForUsageLocation(file, literal, {
    module: ts.ModuleKind.NodeNext,
  });
}
function template(
  file: ts.SourceFile,
  occurrence: ImportRecord,
): DependencyRequestTemplate {
  const literal = findImportRecordLiteral({
    importRecord: occurrence,
    sourceFile: file,
    tsModule: ts,
  });
  const reference = file.typeReferenceDirectives.filter(
    (item) => item.fileName === occurrence.specifier,
  )[occurrence.locator.occurrence];
  return {
    occurrence,
    explicitMode: reference?.resolutionMode ?? explicitUsageMode(file, literal),
    ...requestEligibility(file, occurrence, ts),
  };
}

export function extractFileDependencyFacts(
  filePath: string,
  text: string,
  sourceVersion: string,
): FileDependencyFacts {
  const file = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    getSourceFileKind(filePath),
  );
  const requests = collectTypeScriptSourceFileImports({
    filePath,
    sourceFile: file,
  }).map((record) => template(file, record));
  requests.push(
    ...potentialAugmentations(file, ts).map((occurrence) => ({
      occurrence,
      governance: true,
      expansion: false,
      externalModuleOnly: true,
    })),
  );
  return {
    version: 1,
    compilerVersion: ts.version,
    filePath,
    sourceVersion,
    externalModule: ts.isExternalModule(file),
    declaration: file.isDeclarationFile,
    containsJsx: hasJsx(file),
    noDefaultLib: file.hasNoDefaultLib,
    requests,
    libraries: file.libReferenceDirectives.map((item) => item.fileName),
    jsxRuntime: jsxRuntime(file),
  };
}

function jsxRuntime(file: ts.SourceFile): string | undefined {
  interface Pragma {
    arguments: { factory?: string };
  }
  const value = (
    file as ts.SourceFile & { pragmas: Map<string, Pragma | Pragma[]> }
  ).pragmas.get('jsxruntime');
  return (Array.isArray(value) ? value.at(-1) : value)?.arguments.factory;
}

function hasJsx(node: ts.Node): boolean {
  if (
    [
      ts.isJsxOpeningElement(node),
      ts.isJsxSelfClosingElement(node),
      ts.isJsxFragment(node),
    ].some(Boolean)
  )
    return true;
  return ts.forEachChild(node, (child) => hasJsx(child) || undefined) === true;
}

function hasResolutionMode(
  attributes: ts.ImportAttributes | undefined,
): boolean {
  return (
    attributes?.elements.some(
      (attribute) => attribute.name.text === 'resolution-mode',
    ) ?? false
  );
}
