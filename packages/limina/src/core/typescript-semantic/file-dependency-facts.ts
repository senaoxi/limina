import ts from 'typescript';
import type { ImportRecord } from '../import-analysis/records';
import {
  collectTypeScriptSourceFileImports,
  getSourceFileKind,
} from '../import-analysis/typescript-imports';
import { findImportRecordLiterals } from './import-record';
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
  physicalVersion?: string;
  externalModule: boolean;
  declaration: boolean;
  containsJsx: boolean;
  noDefaultLib: boolean;
  jsxRuntime?: string;
  requests: DependencyRequestTemplate[];
  libraries: string[];
}
export type FileDependencyFactsReader = (
  filePath: string,
  text: string,
  sourceFile?: ts.SourceFile,
) => FileDependencyFacts;

function attributesOf(
  node: ts.Node | undefined,
): ts.ImportAttributes | undefined {
  return node === undefined
    ? undefined
    : (declarationAttributes(node) ?? typeAttributes(node));
}
function declarationAttributes(node: ts.Node): ts.ImportAttributes | undefined {
  if (ts.isImportDeclaration(node)) {
    return node.importClause?.isTypeOnly === true ? node.attributes : undefined;
  }
  if (ts.isExportDeclaration(node)) {
    return node.isTypeOnly ? node.attributes : undefined;
  }
  return ts.isJSDocImportTag(node) ? node.attributes : undefined;
}
function typeAttributes(node: ts.Node): ts.ImportAttributes | undefined {
  if (!ts.isLiteralTypeNode(node)) return undefined;
  return ts.isImportTypeNode(node.parent) ? node.parent.attributes : undefined;
}
function explicitUsageMode(
  literal: ts.StringLiteralLike | null,
): ts.ResolutionMode {
  if (literal === null) return undefined;
  const attributes = attributesOf(literal.parent);
  const attribute = attributes?.elements.find(
    (element) => element.name.text === 'resolution-mode',
  );
  if (attribute === undefined || !ts.isStringLiteral(attribute.value)) {
    return undefined;
  }
  if (attribute.value.text === 'import') return ts.ModuleKind.ESNext;
  return attribute.value.text === 'require'
    ? ts.ModuleKind.CommonJS
    : undefined;
}
function template(
  file: ts.SourceFile,
  filePath: string,
  isExternalModule: boolean,
  occurrence: ImportRecord,
  literal: ts.StringLiteralLike | null,
): DependencyRequestTemplate {
  const reference = file.typeReferenceDirectives.filter(
    (item) => item.fileName === occurrence.specifier,
  )[occurrence.locator.occurrence];
  return {
    occurrence,
    explicitMode: reference?.resolutionMode ?? explicitUsageMode(literal),
    ...requestEligibility(file, occurrence, ts, {
      externalModule: isExternalModule,
      filePath,
    }),
  };
}

function isExternalModuleIndicatorStatement(node: ts.Statement): boolean {
  return (
    ts.isImportDeclaration(node) ||
    ts.isExportDeclaration(node) ||
    ts.isExportAssignment(node) ||
    (ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)) ||
    (ts.canHaveModifiers(node) &&
      (ts
        .getModifiers(node)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
        false))
  );
}

function hasImportMeta(node: ts.Node): boolean {
  return (
    (ts.isMetaProperty(node) &&
      node.keywordToken === ts.SyntaxKind.ImportKeyword &&
      node.name.text === 'meta') ||
    ts.forEachChild(node, (child) => hasImportMeta(child) || undefined) === true
  );
}

/**
Computes external-module syntax neutrality directly from AST nodes rather than
`ts.isExternalModule(file)` because `ts.createProgram` mutates
`externalModuleIndicator` under options such as `moduleDetection: "force"` or
`module: "nodenext"`.
*/
export function isNeutralExternalModule(file: ts.SourceFile): boolean {
  return (
    file.statements.some(isExternalModuleIndicatorStatement) ||
    (file.text.includes('import') &&
      file.text.includes('meta') &&
      hasImportMeta(file))
  );
}

function canReuseProgramSourceFile(
  filePath: string,
  text: string,
  sourceFile: ts.SourceFile | undefined,
): sourceFile is ts.SourceFile {
  if (sourceFile === undefined || sourceFile.text !== text) return false;
  const expectedKind = getSourceFileKind(filePath);
  const actualKind = (
    sourceFile as ts.SourceFile & { scriptKind?: ts.ScriptKind }
  ).scriptKind;
  if (actualKind !== expectedKind) return false;
  const isJsonPath = expectedKind === ts.ScriptKind.JSON;
  const isJsonFile = (sourceFile.flags & ts.NodeFlags.JsonFile) !== 0;
  return isJsonPath === isJsonFile;
}

function canContainJsx(
  file: ts.SourceFile,
  scriptKind: ts.ScriptKind,
): boolean {
  return (
    !file.isDeclarationFile &&
    [ts.ScriptKind.JSX, ts.ScriptKind.TSX, ts.ScriptKind.JS].includes(
      scriptKind,
    )
  );
}

function extractFactsFromNormalizedSourceFile(
  filePath: string,
  file: ts.SourceFile,
  sourceVersion: string,
  scriptKind: ts.ScriptKind,
): FileDependencyFacts {
  const isExternalModule = isNeutralExternalModule(file);
  const records = collectTypeScriptSourceFileImports({
    filePath,
    sourceFile: file,
  });
  const literals = findImportRecordLiterals({
    records,
    sourceFile: file,
    tsModule: ts,
  });
  const requests = records.map((record) =>
    template(
      file,
      filePath,
      isExternalModule,
      record,
      literals.get(record) ?? null,
    ),
  );
  requests.push(
    ...potentialAugmentations(file, ts, filePath).map((occurrence) => ({
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
    externalModule: isExternalModule,
    declaration: file.isDeclarationFile,
    containsJsx: canContainJsx(file, scriptKind) && hasJsx(file),
    noDefaultLib: file.hasNoDefaultLib,
    requests,
    libraries: file.libReferenceDirectives.map((item) => item.fileName),
    jsxRuntime: jsxRuntime(file),
  };
}

export function extractFileDependencyFacts(
  filePath: string,
  text: string,
  sourceVersion: string,
  sourceFile?: ts.SourceFile,
): FileDependencyFacts {
  const scriptKind = getSourceFileKind(filePath);
  const file = canReuseProgramSourceFile(filePath, text, sourceFile)
    ? sourceFile
    : ts.createSourceFile(
        filePath,
        text,
        ts.ScriptTarget.Latest,
        true,
        scriptKind,
      );
  return extractFactsFromNormalizedSourceFile(
    filePath,
    file,
    sourceVersion,
    scriptKind,
  );
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
