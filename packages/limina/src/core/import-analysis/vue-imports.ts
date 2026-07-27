import type { VueImportParser } from '#config/runner';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { collectSourceTextImports } from './oxc-imports';
import { buildLineStarts, getLine, type ImportRecord } from './records';
import type { VueCompilerSfc, VueCompilerSfcBlock } from './types';

const scriptExtractorRE =
  /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script>/giu;
const htmlAttrRE =
  /(?:^|\s)(?<name>[:A-Z_a-z][\w.:-]*)(?:\s*=\s*(?:"(?<doubleQuoted>[^"]*)"|'(?<singleQuoted>[^']*)'|(?<unquoted>[^\s"'<=>`]+)))?/gu;

function getDefinedAttributeValue(
  groups: Record<string, string | undefined>,
): string | undefined {
  return [groups.doubleQuoted, groups.singleQuoted, groups.unquoted].find(
    (value) => value !== undefined,
  );
}

function getMatchedAttributeValue(match: RegExpMatchArray): string {
  if (match.groups === undefined) return '';
  return getDefinedAttributeValue(match.groups) ?? '';
}

function isNamedAttribute(match: RegExpMatchArray, name: string): boolean {
  if (match.groups === undefined) return false;
  return match.groups.name === name;
}

function getHtmlAttributeValue(attrs: string, name: string): string | null {
  for (const match of attrs.matchAll(htmlAttrRE)) {
    if (isNamedAttribute(match, name)) return getMatchedAttributeValue(match);
  }
  return null;
}

function getVueScriptKindFromLang(
  lang: string | null | undefined,
): ts.ScriptKind {
  if (lang === 'tsx') return ts.ScriptKind.TSX;
  if (lang === 'jsx') return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
}

function getVueScriptKind(attrs: string): ts.ScriptKind {
  return getVueScriptKindFromLang(getHtmlAttributeValue(attrs, 'lang'));
}

function getMatchContent(match: RegExpMatchArray): string {
  return match[2] ?? '';
}

function getMatchAttributes(match: RegExpMatchArray): string {
  return match[1] ?? '';
}

function getContentStart(match: RegExpMatchArray, content: string): number {
  return (match.index ?? 0) + match[0].indexOf(content);
}

function collectRegexScriptBlock(options: {
  filePath: string;
  lineStarts: number[];
  match: RegExpMatchArray;
}): ImportRecord[] {
  const attrs = getMatchAttributes(options.match);
  if (getHtmlAttributeValue(attrs, 'src') !== null) return [];
  const content = getMatchContent(options.match);
  const contentStart = getContentStart(options.match, content);
  return collectSourceTextImports({
    filePath: options.filePath,
    lineOffset: getLine(options.lineStarts, contentStart) - 1,
    scriptKind: getVueScriptKind(attrs),
    sourceOffset: contentStart,
    sourceText: content,
  });
}

function collectVueImportsWithRegex(options: {
  filePath: string;
  sourceText: string;
}): ImportRecord[] {
  const imports: ImportRecord[] = [];
  const lineStarts = buildLineStarts(options.sourceText);
  for (const match of options.sourceText.matchAll(scriptExtractorRE)) {
    imports.push(
      ...collectRegexScriptBlock({
        filePath: options.filePath,
        lineStarts,
        match,
      }),
    );
  }
  return imports;
}

function hasErrorCode(error: unknown): error is { code: unknown } {
  if (error === null) return false;
  if (typeof error !== 'object') return false;
  return 'code' in error;
}

function isModuleNotFoundError(error: unknown): boolean {
  if (!hasErrorCode(error)) return false;
  return error.code === 'MODULE_NOT_FOUND';
}

function createMissingCompilerError(projectRootDir: string): Error {
  return new Error(
    [
      'Unable to load Vue SFC compiler for import analysis:',
      '  package: @vue/compiler-sfc',
      `  root: ${projectRootDir}`,
      '  reason: config.imports.vue is "compiler-sfc", but the package is not installed.',
      '  fix: pnpm add -D @vue/compiler-sfc',
    ].join('\n'),
  );
}

function resolveVueCompilerSfc(projectRootDir: string): VueCompilerSfc {
  const requireFromRoot = createRequire(
    path.join(projectRootDir, 'package.json'),
  );
  try {
    return requireFromRoot('@vue/compiler-sfc') as VueCompilerSfc;
  } catch (error) {
    if (isModuleNotFoundError(error)) {
      throw createMissingCompilerError(projectRootDir);
    }
    throw error;
  }
}

function hasMessageField(error: unknown): error is { message: unknown } {
  if (error === null) return false;
  if (typeof error !== 'object') return false;
  return 'message' in error;
}

function getStructuredErrorMessage(error: unknown): string | null {
  if (!hasMessageField(error)) return null;
  if (typeof error.message !== 'string') return null;
  return error.message;
}

function formatCompilerError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return getStructuredErrorMessage(error) ?? String(error);
}

function formatVueCompilerSfcErrors(errors: unknown[]): string {
  return errors.map(formatCompilerError).join('; ');
}

function createVueParseError(options: {
  errors: unknown[];
  filePath: string;
  projectRootDir: string;
}): Error {
  return new Error(
    [
      'Unable to parse Vue SFC for import analysis:',
      `  file: ${path.relative(options.projectRootDir, options.filePath)}`,
      `  reason: ${formatVueCompilerSfcErrors(options.errors)}`,
    ].join('\n'),
  );
}

function getBlockStart(block: VueCompilerSfcBlock) {
  return block.loc?.start;
}

function getBlockOffset(block: VueCompilerSfcBlock): number | undefined {
  const offset = getBlockStart(block)?.offset;
  return typeof offset === 'number' ? offset : undefined;
}

function getVueCompilerSfcBlockContentStart(
  block: VueCompilerSfcBlock,
  sourceText: string,
): number {
  const offset = getBlockOffset(block);
  if (offset !== undefined) return offset;
  return Math.max(sourceText.indexOf(block.content), 0);
}

function getBlockLine(block: VueCompilerSfcBlock): number | undefined {
  const line = getBlockStart(block)?.line;
  return typeof line === 'number' ? line : undefined;
}

function getVueCompilerSfcBlockLineOffset(options: {
  block: VueCompilerSfcBlock;
  contentStart: number;
  lineStarts: number[];
}): number {
  const line = getBlockLine(options.block);
  if (line !== undefined) return line - 1;
  return getLine(options.lineStarts, options.contentStart) - 1;
}

function getAttributeLang(block: VueCompilerSfcBlock): string | null {
  const attrLang = block.attrs?.lang;
  return typeof attrLang === 'string' ? attrLang : null;
}

function getVueCompilerSfcBlockLang(block: VueCompilerSfcBlock): string | null {
  if (block.lang !== undefined) return block.lang;
  return getAttributeLang(block);
}

function isVueBlock(
  value: VueCompilerSfcBlock | null,
): value is VueCompilerSfcBlock {
  return value !== null;
}

function collectCompilerBlock(options: {
  block: VueCompilerSfcBlock;
  filePath: string;
  lineStarts: number[];
  sourceText: string;
}): ImportRecord[] {
  if (options.block.src !== undefined) return [];
  const contentStart = getVueCompilerSfcBlockContentStart(
    options.block,
    options.sourceText,
  );
  return collectSourceTextImports({
    filePath: options.filePath,
    lineOffset: getVueCompilerSfcBlockLineOffset({
      block: options.block,
      contentStart,
      lineStarts: options.lineStarts,
    }),
    scriptKind: getVueScriptKindFromLang(
      getVueCompilerSfcBlockLang(options.block),
    ),
    sourceOffset: contentStart,
    sourceText: options.block.content,
  });
}

function collectVueImportsWithCompiler(options: {
  filePath: string;
  projectRootDir: string;
  sourceText: string;
}): ImportRecord[] {
  const result = resolveVueCompilerSfc(options.projectRootDir).parse(
    options.sourceText,
    { filename: options.filePath },
  );
  if (result.errors.length > 0) {
    throw createVueParseError({
      errors: result.errors,
      filePath: options.filePath,
      projectRootDir: options.projectRootDir,
    });
  }
  const lineStarts = buildLineStarts(options.sourceText);
  const blocks = [
    result.descriptor.scriptSetup,
    result.descriptor.script,
  ].filter(isVueBlock);
  return blocks.flatMap((block) =>
    collectCompilerBlock({
      block,
      filePath: options.filePath,
      lineStarts,
      sourceText: options.sourceText,
    }),
  );
}

export function collectVueImports(options: {
  filePath: string;
  parser: VueImportParser;
  projectRootDir: string;
  sourceText: string;
}): ImportRecord[] {
  if (options.parser === 'compiler-sfc') {
    return collectVueImportsWithCompiler(options);
  }
  return collectVueImportsWithRegex(options);
}
