import ts from 'typescript';
import { collectCommentImports } from './comment-imports';
import {
  buildLineStarts,
  type CollectedImportRecord,
  createImportRecord,
  finalizeImportRecords,
  type ImportRecord,
} from './records';
import { collectRequireImportsFromSourceFile } from './require-bindings';
import {
  type AddTypeScriptImport,
  visitTypeScriptImportNodes,
} from './typescript-node-collectors';

interface TypeScriptImportCollectionOptions {
  filePath: string;
  lineOffset?: number;
  scriptKind: ts.ScriptKind;
  sourceOffset?: number;
  sourceText: string;
  tsModule?: typeof ts;
}

type NormalizedTypeScriptImportCollectionOptions =
  TypeScriptImportCollectionOptions & { tsModule: typeof ts };

function getFileExtension(filePath: string): string {
  const index = filePath.lastIndexOf('.');
  if (index === -1) return '';
  return filePath.slice(index);
}

export function getSourceFileKind(
  filePath: string,
  tsModule: typeof ts = ts,
): ts.ScriptKind {
  const scriptKinds = new Map<string, ts.ScriptKind>([
    ['.cjs', tsModule.ScriptKind.JS],
    ['.js', tsModule.ScriptKind.JS],
    ['.jsx', tsModule.ScriptKind.JSX],
    ['.mjs', tsModule.ScriptKind.JS],
    ['.tsx', tsModule.ScriptKind.TSX],
  ]);
  return scriptKinds.get(getFileExtension(filePath)) ?? tsModule.ScriptKind.TS;
}

function createAddImport(options: {
  collection: NormalizedTypeScriptImportCollectionOptions;
  imports: CollectedImportRecord[];
  lineStarts: number[];
  sourceFile: ts.SourceFile;
}): AddTypeScriptImport {
  const lineOffset = options.collection.lineOffset ?? 0;
  const sourceOffset = options.collection.sourceOffset ?? 0;
  return (specifier, node, kind) => {
    options.imports.push(
      createImportRecord({
        end: node.getEnd(),
        filePath: options.collection.filePath,
        kind,
        lineOffset,
        lineStarts: options.lineStarts,
        pos: node.getStart(options.sourceFile),
        sourceOffset,
        specifier,
      }),
    );
  };
}

export function collectTypeScriptImports(
  options: TypeScriptImportCollectionOptions,
): CollectedImportRecord[] {
  const tsModule = options.tsModule ?? ts;
  const sourceFile = tsModule.createSourceFile(
    options.filePath,
    options.sourceText,
    tsModule.ScriptTarget.Latest,
    true,
    options.scriptKind,
  );
  return collectTypeScriptImportsFromSourceFile({
    ...options,
    sourceFile,
    tsModule,
  });
}

function collectTypeScriptImportsFromSourceFile(
  options: NormalizedTypeScriptImportCollectionOptions & {
    sourceFile: ts.SourceFile;
  },
): CollectedImportRecord[] {
  const imports: CollectedImportRecord[] = [];
  const add = createAddImport({
    collection: options,
    imports,
    lineStarts: buildLineStarts(options.sourceText),
    sourceFile: options.sourceFile,
  });
  visitTypeScriptImportNodes({
    add,
    node: options.sourceFile,
    tsModule: options.tsModule,
  });
  return [...imports, ...collectRequireImportsFromSourceFile(options)];
}

export function collectTypeScriptSourceTextImports(options: {
  filePath: string;
  lineOffset?: number;
  scriptKind?: ts.ScriptKind;
  sourceOffset?: number;
  sourceText: string;
  tsModule?: typeof ts;
}): ImportRecord[] {
  const tsModule = options.tsModule ?? ts;
  const syntax = collectTypeScriptImports({
    ...options,
    scriptKind:
      options.scriptKind ?? getSourceFileKind(options.filePath, tsModule),
    tsModule,
  });
  return finalizeImportRecords([
    ...syntax,
    ...collectCommentImports({ ...options, tsModule }),
  ]);
}

export function collectTypeScriptSourceFileImports(options: {
  filePath: string;
  sourceFile: ts.SourceFile;
  tsModule?: typeof ts;
}): ImportRecord[] {
  const tsModule = options.tsModule ?? ts;
  ensureParentPointers(options.sourceFile, tsModule);
  const sourceText = options.sourceFile.text;
  const syntax = collectTypeScriptImportsFromSourceFile({
    filePath: options.filePath,
    scriptKind: getSourceFileKind(options.filePath, tsModule),
    sourceFile: options.sourceFile,
    sourceText,
    tsModule,
  });
  return finalizeImportRecords([
    ...syntax,
    ...collectCommentImports({
      filePath: options.filePath,
      sourceText,
      tsModule,
    }),
  ]);
}

function ensureParentPointers(
  sourceFile: ts.SourceFile,
  tsModule: typeof ts,
): void {
  const visit = (node: ts.Node, parent?: ts.Node): void => {
    if (parent !== undefined && node.parent === undefined) {
      (node as unknown as { parent: ts.Node }).parent = parent;
    }
    tsModule.forEachChild(node, (child) => visit(child, node));
  };
  visit(sourceFile);
}
