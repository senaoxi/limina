import {
  type CheckerProjectParseContext,
  normalizeExtensions,
  type ResolvedCheckerModuleName,
  resolveModuleNameWithCheckers,
  resolveModuleNameWithCheckersDetailed,
} from '#checkers';
import type { VueImportParser } from '#config/runner';
import { uniqueValues } from '#utils/collections';
import {
  resolveBaseUrlModuleCandidate,
  resolvePathMappedModuleCandidate,
  resolveRelativeModuleCandidate,
} from '#utils/module-resolution';
import { normalizeAbsolutePath } from '#utils/path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { type ParseResult, parseSync, rawTransferSupported } from 'oxc-parser';
import { type NapiResolveOptions, ResolverFactory } from 'oxc-resolver';
import ts from 'typescript';
import {
  buildLineStarts,
  type CollectedImportRecord,
  createImportRecord,
  finalizeImportRecords,
  getLine,
  type ImportRecord,
  type ImportRecordKind,
} from './records';

export type { ImportRecord, ImportRecordKind } from './records';

export interface ImportAnalysisContext {
  collectImportsFromFile: (filePath: string, rootDir: string) => ImportRecord[];
  resolveInternalImport: (
    specifier: string,
    containingFile: string,
    options: ts.CompilerOptions,
    contextOrExtensions?: ImportResolveContextInput,
  ) => string | null;
  resolveOxcImport: (
    specifier: string,
    containingFile: string,
    options: ts.CompilerOptions,
    contextOrExtensions?: ImportResolveContextInput,
  ) => string | null;
  resolveTypeScriptImport: (
    specifier: string,
    containingFile: string,
    options: ts.CompilerOptions,
    contextOrExtensions?: ImportResolveContextInput,
  ) => ResolvedCheckerModuleName | null;
}

export interface CreateImportAnalysisContextOptions {
  isolated?: boolean;
  projectRootDir?: string;
  vueParser?: VueImportParser;
}

export interface ImportResolveContextFields
  extends Pick<CheckerProjectParseContext, 'checkerPresets' | 'extensions'> {
  configPath?: string;
  resolverConfigPath?: string;
}

export type ImportResolveContextInput = ImportResolveContextFields | string[];

type ResolvedImportContext = CheckerProjectParseContext & {
  configPath?: string;
  resolverConfigPath?: string;
};

interface ImportAnalysisCaches {
  importsCache: Map<string, ImportRecord[]>;
  resolutionCache: Map<string, string | null>;
  resolverCache: Map<string, ResolverFactory>;
  sourceTextCache: Map<string, string>;
}

interface VueCompilerSfcBlock {
  attrs?: Record<string, string | true>;
  content: string;
  lang?: string;
  loc?: {
    start?: {
      line?: number;
      offset?: number;
    };
  };
  src?: string;
}

interface VueCompilerSfc {
  parse: (
    source: string,
    options?: { filename?: string },
  ) => {
    descriptor: {
      script: VueCompilerSfcBlock | null;
      scriptSetup: VueCompilerSfcBlock | null;
    };
    errors: unknown[];
  };
}

const jsDocImportRE = /import\(\s*['"]([^'"]+)['"]\s*\)(?:\.\w+)?/gu;
const jsDocImportTagRE =
  /@import\s+(?:\{[^}]*\}|\*\s+as\s+\w+)\s+from\s+['"]([^'"]+)['"]/gu;
const jsxImportSourceRE = /@jsxImportSource\s+([^\s*]+)/gu;
const envPragmaRE = /@(vitest|jest)-environment\s+([@\w./-]+)/gu;
const tripleSlashReferenceRE =
  /\/\/\/\s*<reference\s+(?:types|path)\s*=\s*["']([^"']+)["'][^/]*\/>/gu;
const scriptExtractorRE =
  /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script>/giu;
const htmlAttrRE =
  /(?:^|\s)(?<name>[:A-Z_a-z][\w.:-]*)(?:\s*=\s*(?:"(?<doubleQuoted>[^"]*)"|'(?<singleQuoted>[^']*)'|(?<unquoted>[^\s"'<=>`]+)))?/gu;
// Generated checker typings may lag newer TypeScript enum members.
const moduleKindNode18 = 101 as ts.ModuleKind;
const moduleKindNode20 = 102 as ts.ModuleKind;
const defaultParseOptions = {
  experimentalRawTransfer: rawTransferSupported(),
  sourceType: 'unambiguous' as const,
};
const extensionAlias: NonNullable<NapiResolveOptions['extensionAlias']> = {
  '.cjs': ['.cjs', '.cts', '.d.cts'],
  '.js': ['.js', '.ts', '.tsx', '.d.ts'],
  '.jsx': ['.jsx', '.tsx'],
  '.mjs': ['.mjs', '.mts', '.d.mts'],
};

function getSourceFileKind(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) {
    return ts.ScriptKind.TSX;
  }

  if (filePath.endsWith('.jsx')) {
    return ts.ScriptKind.JSX;
  }

  if (
    filePath.endsWith('.js') ||
    filePath.endsWith('.mjs') ||
    filePath.endsWith('.cjs')
  ) {
    return ts.ScriptKind.JS;
  }

  return ts.ScriptKind.TS;
}

function stringLiteralValue(node: ts.Node | undefined): string | null {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

function isTypeOnlyImportDeclaration(node: ts.ImportDeclaration): boolean {
  if (node.importClause?.isTypeOnly) {
    return true;
  }

  const namedBindings = node.importClause?.namedBindings;

  return (
    !node.importClause?.name &&
    namedBindings !== undefined &&
    ts.isNamedImports(namedBindings) &&
    namedBindings.elements.length > 0 &&
    namedBindings.elements.every((element) => element.isTypeOnly)
  );
}

function collectImportsFromSourceTextWithTypeScript(options: {
  filePath: string;
  lineOffset?: number;
  scriptKind: ts.ScriptKind;
  sourceOffset?: number;
  sourceText: string;
}): CollectedImportRecord[] {
  const sourceFile = ts.createSourceFile(
    options.filePath,
    options.sourceText,
    ts.ScriptTarget.Latest,
    true,
    options.scriptKind,
  );
  const imports: CollectedImportRecord[] = [];
  const lineStarts = buildLineStarts(options.sourceText);
  const lineOffset = options.lineOffset ?? 0;
  const sourceOffset = options.sourceOffset ?? 0;
  const addImport = (
    specifier: string,
    node: ts.Node,
    kind: ImportRecordKind,
  ): void => {
    imports.push(
      createImportRecord({
        filePath: options.filePath,
        kind,
        lineOffset,
        lineStarts,
        pos: node.getStart(sourceFile),
        sourceOffset,
        specifier,
      }),
    );
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      const specifier = stringLiteralValue(moduleSpecifier);

      if (specifier) {
        addImport(
          specifier,
          moduleSpecifier,
          isTypeOnlyImportDeclaration(node) ? 'import-type' : 'static',
        );
      }
    } else if (ts.isExportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      const specifier = stringLiteralValue(moduleSpecifier);

      if (specifier && moduleSpecifier) {
        addImport(specifier, moduleSpecifier, 'export');
      }
    } else if (ts.isImportTypeNode(node)) {
      const specifier = ts.isLiteralTypeNode(node.argument)
        ? stringLiteralValue(node.argument.literal)
        : null;

      if (specifier) {
        addImport(specifier, node.argument, 'import-type');
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const argument = node.arguments[0];
      const specifier = stringLiteralValue(argument);

      if (specifier && argument) {
        addImport(specifier, argument, 'dynamic');
      }
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    ) {
      const argument = node.arguments[0];
      const specifier = stringLiteralValue(argument);

      if (specifier && argument) {
        addImport(specifier, argument, 'commonjs');
      }
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'require' &&
      node.expression.name.text === 'resolve'
    ) {
      const argument = node.arguments[0];
      const specifier = stringLiteralValue(argument);

      if (specifier && argument) {
        addImport(specifier, argument, 'require-resolve');
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const specifier = stringLiteralValue(node.moduleReference.expression);

      if (specifier) {
        addImport(specifier, node.moduleReference.expression, 'import-equals');
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return imports;
}

function getLiteralSpecifierFromSpan(
  sourceText: string,
  span: {
    end: number;
    start: number;
  },
): string | null {
  const text = sourceText.slice(span.start, span.end).trim();
  const quote = text.codePointAt(0);
  const lastQuote = text.codePointAt(text.length - 1);

  if (
    text.length >= 2 &&
    quote === lastQuote &&
    (quote === 34 || quote === 39 || quote === 96) &&
    !(quote === 96 && text.includes('${'))
  ) {
    return text.slice(1, -1);
  }

  return null;
}

function isTriviaSyntaxKind(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.WhitespaceTrivia ||
    kind === ts.SyntaxKind.NewLineTrivia ||
    kind === ts.SyntaxKind.SingleLineCommentTrivia ||
    kind === ts.SyntaxKind.MultiLineCommentTrivia ||
    kind === ts.SyntaxKind.ShebangTrivia ||
    kind === ts.SyntaxKind.ConflictMarkerTrivia
  );
}

function getFirstNonTriviaStart(sourceText: string): number {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    sourceText,
  );

  for (
    let token = scanner.scan();
    token !== ts.SyntaxKind.EndOfFileToken;
    token = scanner.scan()
  ) {
    if (!isTriviaSyntaxKind(token)) {
      return scanner.getTokenPos();
    }
  }

  return sourceText.length;
}

function addCommentImportRecords(options: {
  commentStart: number;
  filePath: string;
  lineOffset: number;
  lineStarts: number[];
  records: CollectedImportRecord[];
  regex: RegExp;
  resolveSpecifier?: (match: RegExpMatchArray) => string | null;
  sourceOffset: number;
  text: string;
}): void {
  options.regex.lastIndex = 0;

  for (const match of options.text.matchAll(options.regex)) {
    const specifier = options.resolveSpecifier
      ? options.resolveSpecifier(match)
      : (match[1] ?? null);

    if (!specifier) {
      continue;
    }

    const specifierOffset = match[0].indexOf(specifier);
    const matchStart = match.index ?? 0;

    options.records.push(
      createImportRecord({
        filePath: options.filePath,
        kind: 'comment',
        lineOffset: options.lineOffset,
        lineStarts: options.lineStarts,
        pos:
          options.commentStart +
          matchStart +
          (specifierOffset === -1 ? 0 : specifierOffset),
        sourceOffset: options.sourceOffset,
        specifier,
      }),
    );
  }
}

function resolveEnvironmentPragma(
  tool: string,
  environment: string,
): string | null {
  if (environment === 'node') {
    return null;
  }

  if (tool === 'jest' && environment === 'jsdom') {
    return 'jest-environment-jsdom';
  }

  if (tool === 'vitest' && environment === 'edge-runtime') {
    return '@edge-runtime/vm';
  }

  return environment;
}

function collectCommentImportRecords(options: {
  filePath: string;
  lineOffset?: number;
  sourceOffset?: number;
  sourceText: string;
}): CollectedImportRecord[] {
  const records: CollectedImportRecord[] = [];
  const lineStarts = buildLineStarts(options.sourceText);
  const lineOffset = options.lineOffset ?? 0;
  const sourceOffset = options.sourceOffset ?? 0;
  const firstNonTriviaStart = getFirstNonTriviaStart(options.sourceText);
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    options.sourceText,
  );

  for (
    let token = scanner.scan();
    token !== ts.SyntaxKind.EndOfFileToken;
    token = scanner.scan()
  ) {
    if (
      token !== ts.SyntaxKind.SingleLineCommentTrivia &&
      token !== ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      continue;
    }

    const commentStart = scanner.getTokenPos();
    const commentEnd = scanner.getTextPos();
    const text = scanner.getTokenText();
    const commonOptions = {
      commentStart,
      filePath: options.filePath,
      lineOffset,
      lineStarts,
      records,
      sourceOffset,
      text,
    };

    addCommentImportRecords({
      ...commonOptions,
      regex: jsDocImportRE,
    });
    addCommentImportRecords({
      ...commonOptions,
      regex: jsDocImportTagRE,
    });
    addCommentImportRecords({
      ...commonOptions,
      regex: jsxImportSourceRE,
    });
    addCommentImportRecords({
      ...commonOptions,
      regex: tripleSlashReferenceRE,
    });

    if (commentEnd <= firstNonTriviaStart) {
      addCommentImportRecords({
        ...commonOptions,
        regex: envPragmaRE,
        resolveSpecifier: (match) => {
          const tool = match[1];
          const environment = match[2];

          return tool && environment
            ? resolveEnvironmentPragma(tool, environment)
            : null;
        },
      });
    }
  }

  return records;
}

function collectImportTypeRecords(options: {
  filePath: string;
  lineOffset: number;
  lineStarts: number[];
  node: unknown;
  records: CollectedImportRecord[];
  sourceOffset: number;
}): void {
  if (!options.node || typeof options.node !== 'object') {
    return;
  }

  if (Array.isArray(options.node)) {
    for (const item of options.node) {
      collectImportTypeRecords({ ...options, node: item });
    }
    return;
  }

  const node = options.node as Record<string, unknown>;

  if (node.type === 'TSImportType') {
    const source = node.source as
      | { start?: unknown; type?: unknown; value?: unknown }
      | undefined;

    if (
      source?.type === 'Literal' &&
      typeof source.value === 'string' &&
      typeof source.start === 'number'
    ) {
      options.records.push(
        createImportRecord({
          filePath: options.filePath,
          kind: 'import-type',
          lineOffset: options.lineOffset,
          lineStarts: options.lineStarts,
          pos: source.start,
          sourceOffset: options.sourceOffset,
          specifier: source.value,
        }),
      );
    }
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') {
      continue;
    }

    collectImportTypeRecords({ ...options, node: value });
  }
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isOxcIdentifier(node: unknown, name: string): boolean {
  const record = getRecord(node);

  return record?.type === 'Identifier' && record.name === name;
}

function getOxcLiteralSpecifier(
  node: unknown,
): { pos: number; specifier: string } | null {
  const record = getRecord(node);

  if (!record) {
    return null;
  }

  if (
    (record.type === 'Literal' || record.type === 'StringLiteral') &&
    typeof record.value === 'string' &&
    typeof record.start === 'number'
  ) {
    return {
      pos: record.start,
      specifier: record.value,
    };
  }

  if (record.type !== 'TemplateLiteral') {
    return null;
  }

  const expressions = Array.isArray(record.expressions)
    ? record.expressions
    : [];
  const quasis = Array.isArray(record.quasis) ? record.quasis : [];
  const quasi = getRecord(quasis[0]);
  const quasiValue = getRecord(quasi?.value);
  const specifier =
    typeof quasiValue?.cooked === 'string'
      ? quasiValue.cooked
      : typeof quasiValue?.raw === 'string'
        ? quasiValue.raw
        : null;

  if (
    expressions.length === 0 &&
    quasis.length === 1 &&
    specifier !== null &&
    typeof record.start === 'number'
  ) {
    return {
      pos: record.start,
      specifier,
    };
  }

  return null;
}

function getOxcCallFirstArgument(node: Record<string, unknown>): unknown {
  return Array.isArray(node.arguments) ? node.arguments[0] : undefined;
}

function getOxcRequireResolveCallee(
  callee: unknown,
): Record<string, unknown> | null {
  const record = getRecord(callee);

  if (record?.type !== 'MemberExpression' || record.computed === true) {
    return null;
  }

  return isOxcIdentifier(record.object, 'require') &&
    isOxcIdentifier(record.property, 'resolve')
    ? record
    : null;
}

function collectOxcCommonJsRecords(options: {
  filePath: string;
  lineOffset: number;
  lineStarts: number[];
  node: unknown;
  records: CollectedImportRecord[];
  sourceOffset: number;
}): void {
  if (!options.node || typeof options.node !== 'object') {
    return;
  }

  if (Array.isArray(options.node)) {
    for (const item of options.node) {
      collectOxcCommonJsRecords({ ...options, node: item });
    }
    return;
  }

  const node = options.node as Record<string, unknown>;

  if (node.type === 'CallExpression') {
    const argument = getOxcLiteralSpecifier(getOxcCallFirstArgument(node));
    const requireResolveCallee = getOxcRequireResolveCallee(node.callee);
    const kind: ImportRecordKind | null = requireResolveCallee
      ? 'require-resolve'
      : isOxcIdentifier(node.callee, 'require')
        ? 'commonjs'
        : null;

    if (argument && kind) {
      options.records.push(
        createImportRecord({
          filePath: options.filePath,
          kind,
          lineOffset: options.lineOffset,
          lineStarts: options.lineStarts,
          pos: argument.pos,
          sourceOffset: options.sourceOffset,
          specifier: argument.specifier,
        }),
      );
    }
  } else if (node.type === 'TSImportEqualsDeclaration') {
    const moduleReference = getRecord(node.moduleReference);
    const argument =
      moduleReference?.type === 'TSExternalModuleReference'
        ? getOxcLiteralSpecifier(moduleReference.expression)
        : null;

    if (argument) {
      options.records.push(
        createImportRecord({
          filePath: options.filePath,
          kind: 'import-equals',
          lineOffset: options.lineOffset,
          lineStarts: options.lineStarts,
          pos: argument.pos,
          sourceOffset: options.sourceOffset,
          specifier: argument.specifier,
        }),
      );
    }
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') {
      continue;
    }

    collectOxcCommonJsRecords({ ...options, node: value });
  }
}

function getOxcStaticImportKind(staticImport: {
  entries?: unknown;
}): ImportRecordKind {
  const entries = Array.isArray(staticImport.entries)
    ? staticImport.entries
    : [];

  return entries.length > 0 &&
    entries.every((entry) => getRecord(entry)?.isType === true)
    ? 'import-type'
    : 'static';
}

function getOxcParseFileName(filePath: string): string {
  const extension = path.extname(filePath);

  return extension === '.vue' || extension === '' ? `${filePath}.ts` : filePath;
}

function collectImportsFromSourceTextWithOxc(options: {
  filePath: string;
  lineOffset?: number;
  sourceOffset?: number;
  sourceText: string;
}): CollectedImportRecord[] | null {
  let parseResult: ParseResult;

  try {
    parseResult = parseSync(
      getOxcParseFileName(options.filePath),
      options.sourceText,
      defaultParseOptions,
    );
  } catch {
    return null;
  }

  if (parseResult.errors.length > 0) {
    return null;
  }

  const imports: CollectedImportRecord[] = [];
  const lineStarts = buildLineStarts(options.sourceText);
  const lineOffset = options.lineOffset ?? 0;
  const sourceOffset = options.sourceOffset ?? 0;

  for (const staticImport of parseResult.module.staticImports) {
    imports.push(
      createImportRecord({
        filePath: options.filePath,
        kind: getOxcStaticImportKind(staticImport),
        lineOffset,
        lineStarts,
        pos: staticImport.moduleRequest.start,
        sourceOffset,
        specifier: staticImport.moduleRequest.value,
      }),
    );
  }

  for (const staticExport of parseResult.module.staticExports) {
    for (const entry of staticExport.entries) {
      if (!entry.moduleRequest) {
        continue;
      }

      imports.push(
        createImportRecord({
          filePath: options.filePath,
          kind: 'export',
          lineOffset,
          lineStarts,
          pos: entry.moduleRequest.start,
          sourceOffset,
          specifier: entry.moduleRequest.value,
        }),
      );
    }
  }

  for (const dynamicImport of parseResult.module.dynamicImports) {
    const specifier = getLiteralSpecifierFromSpan(
      options.sourceText,
      dynamicImport.moduleRequest,
    );

    if (!specifier) {
      continue;
    }

    imports.push(
      createImportRecord({
        filePath: options.filePath,
        kind: 'dynamic',
        lineOffset,
        lineStarts,
        pos: dynamicImport.moduleRequest.start,
        sourceOffset,
        specifier,
      }),
    );
  }

  collectImportTypeRecords({
    filePath: options.filePath,
    lineOffset,
    lineStarts,
    node: parseResult.program,
    records: imports,
    sourceOffset,
  });

  collectOxcCommonJsRecords({
    filePath: options.filePath,
    lineOffset,
    lineStarts,
    node: parseResult.program,
    records: imports,
    sourceOffset,
  });

  return imports;
}

function collectImportsFromSourceText(options: {
  filePath: string;
  lineOffset?: number;
  scriptKind: ts.ScriptKind;
  sourceOffset?: number;
  sourceText: string;
}): ImportRecord[] {
  const oxcImports = collectImportsFromSourceTextWithOxc(options);
  const syntaxImports =
    oxcImports ?? collectImportsFromSourceTextWithTypeScript(options);
  const commentImports = collectCommentImportRecords(options);

  return finalizeImportRecords([...syntaxImports, ...commentImports]);
}

function getHtmlAttributeValue(attrs: string, name: string): string | null {
  for (const match of attrs.matchAll(htmlAttrRE)) {
    if (match.groups?.name !== name) {
      continue;
    }

    return (
      match.groups.doubleQuoted ??
      match.groups.singleQuoted ??
      match.groups.unquoted ??
      ''
    );
  }

  return null;
}

function getVueScriptKind(attrs: string): ts.ScriptKind {
  return getVueScriptKindFromLang(getHtmlAttributeValue(attrs, 'lang'));
}

function getVueScriptKindFromLang(
  lang: string | null | undefined,
): ts.ScriptKind {
  return lang === 'tsx' || lang === 'jsx'
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
}

function collectVueImportsFromSourceText(options: {
  filePath: string;
  sourceText: string;
}): ImportRecord[] {
  const imports: ImportRecord[] = [];
  const lineStarts = buildLineStarts(options.sourceText);

  for (const match of options.sourceText.matchAll(scriptExtractorRE)) {
    const attrs = match[1] ?? '';
    const content = match[2] ?? '';
    const contentStart = match.index + match[0].indexOf(content);
    const lineOffset = getLine(lineStarts, contentStart) - 1;

    if (getHtmlAttributeValue(attrs, 'src') !== null) {
      continue;
    }

    imports.push(
      ...collectImportsFromSourceText({
        filePath: options.filePath,
        lineOffset,
        scriptKind: getVueScriptKind(attrs),
        sourceOffset: contentStart,
        sourceText: content,
      }),
    );
  }

  return imports;
}

function resolveVueCompilerSfc(projectRootDir: string): VueCompilerSfc {
  const requireFromRoot = createRequire(
    path.join(projectRootDir, 'package.json'),
  );

  try {
    return requireFromRoot('@vue/compiler-sfc') as VueCompilerSfc;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'MODULE_NOT_FOUND'
    ) {
      throw new Error(
        [
          'Unable to load Vue SFC compiler for import analysis:',
          '  package: @vue/compiler-sfc',
          `  root: ${projectRootDir}`,
          '  reason: config.imports.vue is "compiler-sfc", but the package is not installed.',
          '  fix: pnpm add -D @vue/compiler-sfc',
        ].join('\n'),
      );
    }

    throw error;
  }
}

function formatVueCompilerSfcErrors(errors: unknown[]): string {
  return errors
    .map((error) => {
      if (
        error &&
        typeof error === 'object' &&
        'message' in error &&
        typeof error.message === 'string'
      ) {
        return error.message;
      }

      return String(error);
    })
    .join('; ');
}

function getVueCompilerSfcBlockContentStart(
  block: VueCompilerSfcBlock,
  sourceText: string,
): number {
  if (typeof block.loc?.start?.offset === 'number') {
    return block.loc.start.offset;
  }

  const index = sourceText.indexOf(block.content);

  return Math.max(index, 0);
}

function getVueCompilerSfcBlockLineOffset(
  block: VueCompilerSfcBlock,
  lineStarts: number[],
  contentStart: number,
): number {
  return typeof block.loc?.start?.line === 'number'
    ? block.loc.start.line - 1
    : getLine(lineStarts, contentStart) - 1;
}

function getVueCompilerSfcBlockLang(block: VueCompilerSfcBlock): string | null {
  if (block.lang) {
    return block.lang;
  }

  const attrLang = block.attrs?.lang;

  return typeof attrLang === 'string' ? attrLang : null;
}

function collectVueImportsFromSourceTextWithCompilerSfc(options: {
  filePath: string;
  projectRootDir: string;
  sourceText: string;
}): ImportRecord[] {
  const compiler = resolveVueCompilerSfc(options.projectRootDir);
  const result = compiler.parse(options.sourceText, {
    filename: options.filePath,
  });

  if (result.errors.length > 0) {
    throw new Error(
      [
        'Unable to parse Vue SFC for import analysis:',
        `  file: ${path.relative(options.projectRootDir, options.filePath)}`,
        `  reason: ${formatVueCompilerSfcErrors(result.errors)}`,
      ].join('\n'),
    );
  }

  const imports: ImportRecord[] = [];
  const lineStarts = buildLineStarts(options.sourceText);
  const blocks = [
    result.descriptor.scriptSetup,
    result.descriptor.script,
  ].filter((block): block is VueCompilerSfcBlock => Boolean(block));

  for (const block of blocks) {
    if (block.src) {
      continue;
    }

    const contentStart = getVueCompilerSfcBlockContentStart(
      block,
      options.sourceText,
    );

    imports.push(
      ...collectImportsFromSourceText({
        filePath: options.filePath,
        lineOffset: getVueCompilerSfcBlockLineOffset(
          block,
          lineStarts,
          contentStart,
        ),
        scriptKind: getVueScriptKindFromLang(getVueCompilerSfcBlockLang(block)),
        sourceOffset: contentStart,
        sourceText: block.content,
      }),
    );
  }

  return imports;
}

function normalizeContextInput(
  contextOrExtensions: ImportResolveContextInput = [],
): ResolvedImportContext {
  return Array.isArray(contextOrExtensions)
    ? {
        checkerPresets: [],
        extensions: contextOrExtensions,
      }
    : {
        checkerPresets: contextOrExtensions.checkerPresets,
        configPath: contextOrExtensions.configPath
          ? normalizeAbsolutePath(contextOrExtensions.configPath)
          : undefined,
        extensions: contextOrExtensions.extensions,
        resolverConfigPath: contextOrExtensions.resolverConfigPath
          ? normalizeAbsolutePath(contextOrExtensions.resolverConfigPath)
          : undefined,
      };
}

function getResolverExtensions(options: {
  compilerOptions: ts.CompilerOptions;
  context: ResolvedImportContext;
}): string[] {
  return normalizeExtensions([
    ...options.context.extensions,
    ...(options.compilerOptions.resolveJsonModule ? ['.json'] : []),
  ]);
}

function getEffectiveModuleResolutionKind(
  compilerOptions: ts.CompilerOptions,
): ts.ModuleResolutionKind {
  if (compilerOptions.moduleResolution !== undefined) {
    return compilerOptions.moduleResolution;
  }

  switch (compilerOptions.module) {
    case ts.ModuleKind.Node16:
    case moduleKindNode18:
    case moduleKindNode20: {
      return ts.ModuleResolutionKind.Node16;
    }
    case ts.ModuleKind.NodeNext: {
      return ts.ModuleResolutionKind.NodeNext;
    }
    case ts.ModuleKind.Preserve: {
      return ts.ModuleResolutionKind.Bundler;
    }
    default: {
      return ts.ModuleResolutionKind.Node10;
    }
  }
}

function supportsPackageJsonExportsAndImports(
  compilerOptions: ts.CompilerOptions,
): boolean {
  switch (getEffectiveModuleResolutionKind(compilerOptions)) {
    case ts.ModuleResolutionKind.Node16:
    case ts.ModuleResolutionKind.NodeNext:
    case ts.ModuleResolutionKind.Bundler: {
      return true;
    }
    default: {
      return false;
    }
  }
}

function getConditionNames(compilerOptions: ts.CompilerOptions): string[] {
  if (!supportsPackageJsonExportsAndImports(compilerOptions)) {
    return [];
  }

  return uniqueValues([
    ...(compilerOptions.customConditions ?? []),
    'import',
    'require',
    'node',
    'default',
  ]);
}

function hasTypeScriptOnlyResolutionOptions(
  compilerOptions: ts.CompilerOptions,
): boolean {
  return (
    compilerOptions.moduleResolution === ts.ModuleResolutionKind.Classic ||
    Boolean(compilerOptions.allowArbitraryExtensions) ||
    compilerOptions.resolvePackageJsonExports === false ||
    compilerOptions.resolvePackageJsonImports === false ||
    (compilerOptions.rootDirs?.length ?? 0) > 0 ||
    (compilerOptions.moduleSuffixes?.length ?? 0) > 0
  );
}

function createResolverOptions(options: {
  compilerOptions: ts.CompilerOptions;
  configPath: string;
  extensions: string[];
}): NapiResolveOptions {
  const packageJsonExportsAndImports = supportsPackageJsonExportsAndImports(
    options.compilerOptions,
  );

  return {
    conditionNames: getConditionNames(options.compilerOptions),
    extensionAlias,
    extensions: options.extensions,
    ...(packageJsonExportsAndImports
      ? {}
      : {
          exportsFields: [],
          importsFields: [],
        }),
    nodePath: false,
    symlinks: options.compilerOptions.preserveSymlinks !== true,
    tsconfig: {
      configFile: options.configPath,
    },
  };
}

function createResolverCacheKey(options: {
  compilerOptions: ts.CompilerOptions;
  configPath: string;
  extensions: string[];
}): string {
  const packageJsonExportsAndImports = supportsPackageJsonExportsAndImports(
    options.compilerOptions,
  );

  return JSON.stringify({
    conditions: getConditionNames(options.compilerOptions),
    configPath: options.configPath,
    extensions: options.extensions,
    packageJsonExportsAndImports,
    preserveSymlinks: options.compilerOptions.preserveSymlinks === true,
  });
}

function getRequiredOxcConfigPath(options: {
  containingFile: string;
  context: ResolvedImportContext;
  specifier: string;
}): string {
  if (options.context.resolverConfigPath) {
    return options.context.resolverConfigPath;
  }

  if (options.context.configPath) {
    return options.context.configPath;
  }

  throw new Error(
    [
      'Unable to resolve module with Oxc:',
      `  specifier: ${options.specifier}`,
      `  containing file: ${options.containingFile}`,
      '  reason: Oxc resolution requires the importer tsconfig configPath.',
    ].join('\n'),
  );
}

function normalizeResolvedPathForImporter(
  resolvedPath: string,
  containingFile: string,
): string {
  const normalizedPath = normalizeAbsolutePath(resolvedPath);
  const normalizedContainingFile = normalizeAbsolutePath(containingFile);

  if (
    normalizedContainingFile.startsWith('/var/') &&
    normalizedPath.startsWith('/private/var/')
  ) {
    return normalizedPath.slice('/private'.length);
  }

  return normalizedPath;
}

function createImportAnalysisCaches(): ImportAnalysisCaches {
  return {
    importsCache: new Map<string, ImportRecord[]>(),
    resolutionCache: new Map<string, string | null>(),
    resolverCache: new Map<string, ResolverFactory>(),
    sourceTextCache: new Map<string, string>(),
  };
}

const sharedImportAnalysisCaches = createImportAnalysisCaches();

export function clearImportAnalysisCache(): void {
  sharedImportAnalysisCaches.importsCache.clear();
  sharedImportAnalysisCaches.resolutionCache.clear();
  sharedImportAnalysisCaches.resolverCache.clear();
  sharedImportAnalysisCaches.sourceTextCache.clear();
}

function resolveModuleNameWithOxcCaches(
  caches: ImportAnalysisCaches,
  options: {
    compilerOptions: ts.CompilerOptions;
    containingFile: string;
    context: ResolvedImportContext;
    specifier: string;
  },
): string | null {
  const configPath = getRequiredOxcConfigPath({
    containingFile: options.containingFile,
    context: options.context,
    specifier: options.specifier,
  });
  const extensions = getResolverExtensions({
    compilerOptions: options.compilerOptions,
    context: options.context,
  });
  const resolverCacheKey = createResolverCacheKey({
    compilerOptions: options.compilerOptions,
    configPath,
    extensions,
  });
  const resolver =
    caches.resolverCache.get(resolverCacheKey) ??
    new ResolverFactory(
      createResolverOptions({
        compilerOptions: options.compilerOptions,
        configPath,
        extensions,
      }),
    );

  caches.resolverCache.set(resolverCacheKey, resolver);

  let resolved: ReturnType<ResolverFactory['resolveFileSync']>;

  try {
    resolved = resolver.resolveFileSync(
      options.containingFile,
      options.specifier,
    );
  } catch {
    return null;
  }

  return resolved.path
    ? normalizeResolvedPathForImporter(resolved.path, options.containingFile)
    : null;
}

export function resolveModuleNameWithOxc(options: {
  compilerOptions: ts.CompilerOptions;
  containingFile: string;
  context?: ImportResolveContextInput;
  specifier: string;
}): string | null {
  return resolveModuleNameWithOxcCaches(sharedImportAnalysisCaches, {
    compilerOptions: options.compilerOptions,
    containingFile: normalizeAbsolutePath(options.containingFile),
    context: normalizeContextInput(options.context),
    specifier: options.specifier,
  });
}

export function createImportAnalysisContext(
  options: CreateImportAnalysisContextOptions = {},
): ImportAnalysisContext {
  const caches = options.isolated
    ? createImportAnalysisCaches()
    : sharedImportAnalysisCaches;
  const vueParser = options.vueParser ?? 'heuristic';

  const readSourceText = (filePath: string): string => {
    if (!caches.sourceTextCache.has(filePath)) {
      caches.sourceTextCache.set(filePath, readFileSync(filePath, 'utf8'));
    }

    return caches.sourceTextCache.get(filePath)!;
  };

  const collectImportsFromFile = (
    filePath: string,
    rootDir: string,
  ): ImportRecord[] => {
    const normalizedFilePath = normalizeAbsolutePath(filePath);
    const projectRootDir = normalizeAbsolutePath(
      options.projectRootDir ?? rootDir,
    );
    const cacheKey = JSON.stringify({
      filePath: normalizedFilePath,
      projectRootDir,
      vueParser,
    });
    const cached = caches.importsCache.get(cacheKey);

    if (cached) {
      return cached;
    }

    const sourceText = readSourceText(normalizedFilePath);
    const imports = normalizedFilePath.endsWith('.vue')
      ? vueParser === 'compiler-sfc'
        ? collectVueImportsFromSourceTextWithCompilerSfc({
            filePath: normalizedFilePath,
            projectRootDir,
            sourceText,
          })
        : collectVueImportsFromSourceText({
            filePath: normalizedFilePath,
            sourceText,
          })
      : collectImportsFromSourceText({
          filePath: normalizedFilePath,
          scriptKind: getSourceFileKind(normalizedFilePath),
          sourceText,
        });

    caches.importsCache.set(cacheKey, imports);
    return imports;
  };

  const resolveTypeScriptImport = (
    specifier: string,
    containingFile: string,
    compilerOptions: ts.CompilerOptions,
    contextOrExtensions?: ImportResolveContextInput,
  ): ResolvedCheckerModuleName | null =>
    resolveModuleNameWithCheckersDetailed({
      compilerOptions,
      containingFile: normalizeAbsolutePath(containingFile),
      context: normalizeContextInput(contextOrExtensions),
      specifier,
    });

  const resolveOxcImport = (
    specifier: string,
    containingFile: string,
    compilerOptions: ts.CompilerOptions,
    contextOrExtensions?: ImportResolveContextInput,
  ): string | null =>
    resolveModuleNameWithOxcCaches(caches, {
      compilerOptions,
      containingFile: normalizeAbsolutePath(containingFile),
      context: normalizeContextInput(contextOrExtensions),
      specifier,
    });

  const resolveInternalImport = (
    specifier: string,
    containingFile: string,
    options: ts.CompilerOptions,
    contextOrExtensions?: ImportResolveContextInput,
  ): string | null => {
    const normalizedContainingFile = normalizeAbsolutePath(containingFile);
    const context = normalizeContextInput(contextOrExtensions);
    const extensions = getResolverExtensions({
      compilerOptions: options,
      context,
    });
    const cacheKey = JSON.stringify({
      configPath: context.configPath ?? null,
      containingFile: normalizedContainingFile,
      extensions,
      options: {
        allowArbitraryExtensions: options.allowArbitraryExtensions,
        baseUrl: options.baseUrl,
        customConditions: options.customConditions,
        moduleResolution: options.moduleResolution,
        moduleSuffixes: options.moduleSuffixes,
        paths: options.paths,
        pathsBasePath: (options as { pathsBasePath?: unknown }).pathsBasePath,
        preserveSymlinks: options.preserveSymlinks,
        resolvePackageJsonExports: options.resolvePackageJsonExports,
        resolvePackageJsonImports: options.resolvePackageJsonImports,
        resolveJsonModule: options.resolveJsonModule,
        rootDirs: options.rootDirs,
      },
      resolverConfigPath: context.resolverConfigPath ?? null,
      specifier,
    });
    const cached = caches.resolutionCache.get(cacheKey);

    if (cached !== undefined) {
      return cached;
    }

    const preferTypeScriptResolver =
      hasTypeScriptOnlyResolutionOptions(options);
    const typeScriptResolved = preferTypeScriptResolver
      ? resolveTypeScriptImport(
          specifier,
          normalizedContainingFile,
          options,
          context,
        )?.resolvedFileName
      : null;
    const resolved =
      typeScriptResolved ??
      resolveRelativeModuleCandidate({
        containingFile: normalizedContainingFile,
        extensions,
        specifier,
      }) ??
      resolvePathMappedModuleCandidate({
        compilerOptions: options,
        extensions,
        specifier,
      }) ??
      resolveBaseUrlModuleCandidate({
        compilerOptions: options,
        extensions,
        specifier,
      }) ??
      (preferTypeScriptResolver
        ? null
        : (resolveOxcImport(
            specifier,
            normalizedContainingFile,
            options,
            context,
          ) ??
          resolveModuleNameWithCheckers({
            compilerOptions: options,
            containingFile: normalizedContainingFile,
            context,
            specifier,
          })));

    caches.resolutionCache.set(cacheKey, resolved);
    return resolved;
  };

  return {
    collectImportsFromFile,
    resolveInternalImport,
    resolveOxcImport,
    resolveTypeScriptImport,
  };
}

export function collectImportsFromFile(
  filePath: string,
  rootDir: string,
  context?: ImportAnalysisContext,
): ImportRecord[] {
  return (context ?? createImportAnalysisContext()).collectImportsFromFile(
    filePath,
    rootDir,
  );
}

export function resolveInternalImport(
  specifier: string,
  containingFile: string,
  options: ts.CompilerOptions,
  contextOrExtensions?: ImportResolveContextInput,
  analysisContext?: ImportAnalysisContext,
): string | null {
  return (
    analysisContext ?? createImportAnalysisContext()
  ).resolveInternalImport(
    specifier,
    containingFile,
    options,
    contextOrExtensions,
  );
}

export { type ResolvedCheckerModuleName } from '#checkers';
