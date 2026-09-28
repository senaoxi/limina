import ts from 'typescript';
import {
  buildLineStarts,
  type CollectedImportRecord,
  createImportRecord,
  type ImportRecordKind,
} from './records';

const jsDocImportRE = /import\(\s*['"]([^'"]+)['"]\s*\)(?:\.\w+)?/gu;
const jsDocImportTagRE =
  /@import\s+(?:\{[^}]*\}|\*\s+as\s+\w+)\s+from\s+['"]([^'"]+)['"]/gu;
const jsxImportSourceRE = /@jsxImportSource\s+([^\s*]+)/gu;
const envPragmaRE = /@(vitest|jest)-environment\s+([@\w./-]+)/gu;
const tripleSlashPathReferenceRE =
  /\/\/\/\s*<reference\s+path\s*=\s*["']([^"']+)["'][^/]*\/>/gu;
const tripleSlashTypesReferenceRE =
  /\/\/\/\s*<reference\s+types\s*=\s*["']([^"']+)["'][^/]*\/>/gu;

interface CommentImportOptions {
  commentStart: number;
  filePath: string;
  kind: ImportRecordKind;
  lineOffset: number;
  lineStarts: number[];
  records: CollectedImportRecord[];
  regex: RegExp;
  resolveSpecifier?: (match: RegExpMatchArray) => string | null;
  sourceOffset: number;
  text: string;
}

function getTriviaKinds(tsModule: typeof ts): ReadonlySet<ts.SyntaxKind> {
  return new Set([
    tsModule.SyntaxKind.WhitespaceTrivia,
    tsModule.SyntaxKind.NewLineTrivia,
    tsModule.SyntaxKind.SingleLineCommentTrivia,
    tsModule.SyntaxKind.MultiLineCommentTrivia,
    tsModule.SyntaxKind.ShebangTrivia,
    tsModule.SyntaxKind.ConflictMarkerTrivia,
  ]);
}

function getCommentKinds(tsModule: typeof ts): ReadonlySet<ts.SyntaxKind> {
  return new Set([
    tsModule.SyntaxKind.SingleLineCommentTrivia,
    tsModule.SyntaxKind.MultiLineCommentTrivia,
  ]);
}

function getFirstNonTriviaStart(
  sourceText: string,
  tsModule: typeof ts,
): number {
  const triviaKinds = getTriviaKinds(tsModule);
  const scanner = tsModule.createScanner(
    tsModule.ScriptTarget.Latest,
    false,
    tsModule.LanguageVariant.Standard,
    sourceText,
  );
  for (
    let token = scanner.scan();
    token !== tsModule.SyntaxKind.EndOfFileToken;
    token = scanner.scan()
  ) {
    if (!triviaKinds.has(token)) return scanner.getTokenPos();
  }
  return sourceText.length;
}

function getMatchedSpecifier(
  options: CommentImportOptions,
  match: RegExpMatchArray,
): string | null {
  if (options.resolveSpecifier !== undefined) {
    return options.resolveSpecifier(match);
  }
  return match[1] ?? null;
}

function isQuote(value: string | undefined): boolean {
  return value === '"' || value === "'" || value === '`';
}

function hasStringQuotes(options: {
  after: string | undefined;
  before: string | undefined;
}): boolean {
  if (!isQuote(options.before)) return false;
  return options.before === options.after;
}

function getSpecifierOffset(
  match: RegExpMatchArray,
  specifier: string,
): number {
  return match[0].indexOf(specifier);
}

function getTokenStart(options: {
  commentStart: number;
  match: RegExpMatchArray;
  quoted: boolean;
  specifierOffset: number;
}): number {
  const matchStart = options.match.index ?? 0;
  const innerOffset =
    options.specifierOffset === -1 ? 0 : options.specifierOffset;
  return (
    options.commentStart + matchStart + innerOffset - Number(options.quoted)
  );
}

function appendCommentMatch(options: {
  collection: CommentImportOptions;
  match: RegExpMatchArray;
  specifier: string;
}): void {
  const offset = getSpecifierOffset(options.match, options.specifier);
  const before = offset > 0 ? options.match[0][offset - 1] : undefined;
  const quoted = hasStringQuotes({
    after: options.match[0][offset + options.specifier.length],
    before,
  });
  const tokenStart = getTokenStart({
    commentStart: options.collection.commentStart,
    match: options.match,
    quoted,
    specifierOffset: offset,
  });
  options.collection.records.push(
    createImportRecord({
      end: tokenStart + options.specifier.length + (quoted ? 2 : 0),
      filePath: options.collection.filePath,
      kind: options.collection.kind,
      lineOffset: options.collection.lineOffset,
      lineStarts: options.collection.lineStarts,
      pos: tokenStart,
      sourceOffset: options.collection.sourceOffset,
      specifier: options.specifier,
    }),
  );
}

function hasSpecifier(specifier: string | null): specifier is string {
  if (specifier === null) return false;
  return specifier.length > 0;
}

function addCommentImportRecords(options: CommentImportOptions): void {
  options.regex.lastIndex = 0;
  for (const match of options.text.matchAll(options.regex)) {
    const specifier = getMatchedSpecifier(options, match);
    if (!hasSpecifier(specifier)) continue;
    appendCommentMatch({ collection: options, match, specifier });
  }
}

const ENVIRONMENT_PRAGMA_ALIASES = new Map<string, string | null>([
  ['jest\0jsdom', 'jest-environment-jsdom'],
  ['vitest\0edge-runtime', '@edge-runtime/vm'],
  ['jest\0node', null],
  ['vitest\0node', null],
]);

function resolveEnvironmentPragma(
  tool: string,
  environment: string,
): string | null {
  const key = `${tool}\0${environment}`;
  if (ENVIRONMENT_PRAGMA_ALIASES.has(key)) {
    return ENVIRONMENT_PRAGMA_ALIASES.get(key) ?? null;
  }
  return environment;
}

function resolvePragmaMatch(match: RegExpMatchArray): string | null {
  const tool = match[1];
  const environment = match[2];
  if (tool === undefined) return null;
  if (environment === undefined) return null;
  return resolveEnvironmentPragma(tool, environment);
}

function addStandardCommentImports(
  common: Omit<CommentImportOptions, 'kind' | 'regex'>,
): void {
  const entries: [ImportRecordKind, RegExp][] = [
    ['jsdoc-import', jsDocImportRE],
    ['jsdoc-import', jsDocImportTagRE],
    ['jsx-import-source', jsxImportSourceRE],
    ['triple-slash-path', tripleSlashPathReferenceRE],
    ['triple-slash-types', tripleSlashTypesReferenceRE],
  ];
  for (const [kind, regex] of entries) {
    addCommentImportRecords({ ...common, kind, regex });
  }
}

function addEnvironmentCommentImport(
  common: Omit<CommentImportOptions, 'kind' | 'regex'>,
): void {
  addCommentImportRecords({
    ...common,
    kind: 'environment-pragma',
    regex: envPragmaRE,
    resolveSpecifier: resolvePragmaMatch,
  });
}

function processCommentToken(options: {
  filePath: string;
  firstNonTriviaStart: number;
  lineOffset: number;
  lineStarts: number[];
  records: CollectedImportRecord[];
  scanner: ts.Scanner;
  sourceOffset: number;
}): void {
  const commentStart = options.scanner.getTokenPos();
  const common = {
    commentStart,
    filePath: options.filePath,
    lineOffset: options.lineOffset,
    lineStarts: options.lineStarts,
    records: options.records,
    sourceOffset: options.sourceOffset,
    text: options.scanner.getTokenText(),
  };
  addStandardCommentImports(common);
  if (options.scanner.getTextPos() <= options.firstNonTriviaStart) {
    addEnvironmentCommentImport(common);
  }
}

interface CommentScanContext {
  filePath: string;
  firstNonTriviaStart: number;
  lineOffset: number;
  lineStarts: number[];
  records: CollectedImportRecord[];
  scanner: ts.Scanner;
  sourceOffset: number;
  tsModule: typeof ts;
}

function scanCommentTokens(context: CommentScanContext): void {
  const commentKinds = getCommentKinds(context.tsModule);
  for (
    let token = context.scanner.scan();
    token !== context.tsModule.SyntaxKind.EndOfFileToken;
    token = context.scanner.scan()
  ) {
    if (commentKinds.has(token)) processCommentToken(context);
  }
}

function getLineOffset(value: number | undefined): number {
  if (value === undefined) return 0;
  return value;
}

export function collectCommentImports(options: {
  filePath: string;
  lineOffset?: number;
  sourceOffset?: number;
  sourceText: string;
  tsModule?: typeof ts;
}): CollectedImportRecord[] {
  const tsModule = options.tsModule ?? ts;
  const records: CollectedImportRecord[] = [];
  const scanner = tsModule.createScanner(
    tsModule.ScriptTarget.Latest,
    false,
    tsModule.LanguageVariant.Standard,
    options.sourceText,
  );
  scanCommentTokens({
    filePath: options.filePath,
    firstNonTriviaStart: getFirstNonTriviaStart(options.sourceText, tsModule),
    lineOffset: getLineOffset(options.lineOffset),
    lineStarts: buildLineStarts(options.sourceText),
    records,
    scanner,
    sourceOffset: getLineOffset(options.sourceOffset),
    tsModule,
  });
  return records;
}
