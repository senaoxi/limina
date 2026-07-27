import type { ParseResult } from 'oxc-parser';
import { getRecord, type OxcCollectionContext } from './oxc-ast';
import { createImportRecord, type ImportRecordKind } from './records';

function hasStaticImportEntries(entries: unknown): entries is unknown[] {
  if (!Array.isArray(entries)) return false;
  return entries.length > 0;
}

function areAllEntriesTypeOnly(entries: unknown[]): boolean {
  return entries.every((entry) => getRecord(entry)?.isType === true);
}

function getStaticImportKind(staticImport: {
  entries?: unknown;
}): ImportRecordKind {
  if (!hasStaticImportEntries(staticImport.entries)) return 'static';
  return areAllEntriesTypeOnly(staticImport.entries) ? 'import-type' : 'static';
}

export function collectStaticImports(
  context: OxcCollectionContext,
  result: ParseResult,
): void {
  for (const entry of result.module.staticImports) {
    context.records.push(
      createImportRecord({
        end: entry.moduleRequest.end,
        filePath: context.filePath,
        kind: getStaticImportKind(entry),
        lineOffset: context.lineOffset,
        lineStarts: context.lineStarts,
        pos: entry.moduleRequest.start,
        sourceOffset: context.sourceOffset,
        specifier: entry.moduleRequest.value,
      }),
    );
  }
}

function appendStaticExport(options: {
  context: OxcCollectionContext;
  moduleRequest: {
    end: number;
    start: number;
    value: string;
  };
}): void {
  options.context.records.push(
    createImportRecord({
      end: options.moduleRequest.end,
      filePath: options.context.filePath,
      kind: 'export',
      lineOffset: options.context.lineOffset,
      lineStarts: options.context.lineStarts,
      pos: options.moduleRequest.start,
      sourceOffset: options.context.sourceOffset,
      specifier: options.moduleRequest.value,
    }),
  );
}

function hasModuleRequest<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function collectStaticExportEntries(options: {
  context: OxcCollectionContext;
  entries: ParseResult['module']['staticExports'][number]['entries'];
}): void {
  for (const entry of options.entries) {
    const request = entry.moduleRequest;
    if (!hasModuleRequest(request)) continue;
    appendStaticExport({ context: options.context, moduleRequest: request });
  }
}

export function collectStaticExports(
  context: OxcCollectionContext,
  result: ParseResult,
): void {
  for (const staticExport of result.module.staticExports) {
    collectStaticExportEntries({ context, entries: staticExport.entries });
  }
}

function isSupportedQuote(codePoint: number | undefined): boolean {
  if (codePoint === 34) return true;
  if (codePoint === 39) return true;
  return codePoint === 96;
}

function hasDynamicTemplateExpression(options: {
  quote: number | undefined;
  text: string;
}): boolean {
  if (options.quote !== 96) return false;
  return options.text.includes('${');
}

function hasMatchingQuotes(options: {
  quote: number | undefined;
  text: string;
}): boolean {
  return options.quote === options.text.codePointAt(options.text.length - 1);
}

function isStaticQuotedText(options: {
  quote: number | undefined;
  text: string;
}): boolean {
  if (!hasMatchingQuotes(options)) return false;
  if (!isSupportedQuote(options.quote)) return false;
  return !hasDynamicTemplateExpression(options);
}

function getLiteralSpecifierFromSpan(
  sourceText: string,
  span: { end: number; start: number },
): string | null {
  const text = sourceText.slice(span.start, span.end).trim();
  if (text.length < 2) return null;
  const quote = text.codePointAt(0);
  if (!isStaticQuotedText({ quote, text })) return null;
  return text.slice(1, -1);
}

function appendDynamicImport(options: {
  context: OxcCollectionContext;
  request: { end: number; start: number };
  specifier: string;
}): void {
  options.context.records.push(
    createImportRecord({
      end: options.request.end,
      filePath: options.context.filePath,
      kind: 'dynamic',
      lineOffset: options.context.lineOffset,
      lineStarts: options.context.lineStarts,
      pos: options.request.start,
      sourceOffset: options.context.sourceOffset,
      specifier: options.specifier,
    }),
  );
}

export function collectDynamicImports(options: {
  context: OxcCollectionContext;
  result: ParseResult;
  sourceText: string;
}): void {
  for (const entry of options.result.module.dynamicImports) {
    const specifier = getLiteralSpecifierFromSpan(
      options.sourceText,
      entry.moduleRequest,
    );
    if (specifier === null) continue;
    appendDynamicImport({
      context: options.context,
      request: entry.moduleRequest,
      specifier,
    });
  }
}
