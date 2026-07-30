import path from 'node:path';
import { type ParseResult, parseSync, rawTransferSupported } from 'oxc-parser';
import type ts from 'typescript';
import { collectCommentImports } from './comment-imports';
import type { OxcCollectionContext } from './oxc-ast';
import {
  collectDynamicImports,
  collectStaticExports,
  collectStaticImports,
} from './oxc-module-records';
import { collectOxcProgramRecords } from './oxc-program-records';
import {
  buildLineStarts,
  type CollectedImportRecord,
  finalizeImportRecords,
  type ImportRecord,
} from './records';
import { collectRequireImports } from './require-bindings';
import {
  collectTypeScriptImports,
  getSourceFileKind,
} from './typescript-imports';

const defaultParseOptions = {
  experimentalRawTransfer: rawTransferSupported(),
  sourceType: 'unambiguous' as const,
};

interface OxcImportCollectionOptions {
  filePath: string;
  lineOffset?: number;
  sourceOffset?: number;
  sourceText: string;
}

function getOxcParseFileName(filePath: string): string {
  const extension = path.extname(filePath);
  if (extension === '.vue') return `${filePath}.ts`;
  if (extension.length === 0) return `${filePath}.ts`;
  return filePath;
}

function hasParseErrors(result: ParseResult): boolean {
  return result.errors.length > 0;
}

function parseOxcSource(
  options: OxcImportCollectionOptions,
): ParseResult | null {
  try {
    const result = parseSync(
      getOxcParseFileName(options.filePath),
      options.sourceText,
      defaultParseOptions,
    );
    return hasParseErrors(result) ? null : result;
  } catch {
    return null;
  }
}

function createCollectionContext(
  options: OxcImportCollectionOptions,
): OxcCollectionContext {
  return {
    filePath: options.filePath,
    lineOffset: options.lineOffset ?? 0,
    lineStarts: buildLineStarts(options.sourceText),
    records: [],
    sourceOffset: options.sourceOffset ?? 0,
  };
}

export function collectOxcImports(
  options: OxcImportCollectionOptions,
): CollectedImportRecord[] | null {
  const result = parseOxcSource(options);
  if (result === null) return null;
  const context = createCollectionContext(options);
  collectStaticImports(context, result);
  collectStaticExports(context, result);
  collectDynamicImports({ context, result, sourceText: options.sourceText });
  collectOxcProgramRecords({ context, program: result.program });
  context.records.push(
    ...collectRequireImports({
      ...options,
      scriptKind: getSourceFileKind(options.filePath),
    }),
  );
  return context.records;
}

function getScriptKind(options: {
  filePath: string;
  scriptKind?: ts.ScriptKind;
}): ts.ScriptKind {
  if (options.scriptKind !== undefined) return options.scriptKind;
  return getSourceFileKind(options.filePath);
}

function collectSyntaxImports(options: {
  filePath: string;
  lineOffset?: number;
  scriptKind?: ts.ScriptKind;
  sourceOffset?: number;
  sourceText: string;
}): CollectedImportRecord[] {
  const oxc = collectOxcImports(options);
  if (oxc !== null) return oxc;
  return collectTypeScriptImports({
    ...options,
    scriptKind: getScriptKind(options),
  });
}

export function collectSourceTextImports(options: {
  filePath: string;
  lineOffset?: number;
  scriptKind?: ts.ScriptKind;
  sourceOffset?: number;
  sourceText: string;
}): ImportRecord[] {
  const syntax = collectSyntaxImports(options);
  const comments = collectCommentImports(options);
  return finalizeImportRecords([...syntax, ...comments]);
}
