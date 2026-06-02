import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { type ParseResult, parseSync, rawTransferSupported } from 'oxc-parser';
import { type NapiResolveOptions, ResolverFactory } from 'oxc-resolver';
import ts from 'typescript';
import {
  type CheckerProjectParseContext,
  normalizeExtensions,
  resolveModuleNameWithCheckers,
} from './checkers';
import { normalizeAbsolutePath } from './utils/path';

export interface ImportRecord {
  filePath: string;
  line: number;
  specifier: string;
}

export interface ImportAnalysisContext {
  collectImportsFromFile: (filePath: string, rootDir: string) => ImportRecord[];
  resolveInternalImport: (
    specifier: string,
    containingFile: string,
    options: ts.CompilerOptions,
    contextOrExtensions?: ImportResolveContextInput,
  ) => string | null;
}

type ImportResolveContextInput =
  | CheckerProjectParseContext
  | Pick<CheckerProjectParseContext, 'checkerPresets' | 'extensions'>
  | string[];

type ResolvedImportContext = CheckerProjectParseContext;

const importOrExportKeywordRE = /\b(?:import|export)\b/u;
const scriptExtractorRE =
  /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script>/giu;
const htmlAttrRE =
  /(?:^|\s)(?<name>[:A-Z_a-z][\w.:-]*)(?:\s*=\s*(?:"(?<doubleQuoted>[^"]*)"|'(?<singleQuoted>[^']*)'|(?<unquoted>[^\s"'<=>`]+)))?/gu;
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

function collectImportsFromSourceTextWithTypeScript(options: {
  filePath: string;
  lineOffset?: number;
  scriptKind: ts.ScriptKind;
  sourceText: string;
}): ImportRecord[] {
  const sourceFile = ts.createSourceFile(
    options.filePath,
    options.sourceText,
    ts.ScriptTarget.Latest,
    true,
    options.scriptKind,
  );
  const imports: ImportRecord[] = [];
  const lineOffset = options.lineOffset ?? 0;
  const addImport = (specifier: string, node: ts.Node): void => {
    const location = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );

    imports.push({
      filePath: options.filePath,
      line: lineOffset + location.line + 1,
      specifier,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = stringLiteralValue(node.moduleSpecifier);

      if (specifier) {
        addImport(specifier, node);
      }
    } else if (ts.isImportTypeNode(node)) {
      const specifier = ts.isLiteralTypeNode(node.argument)
        ? stringLiteralValue(node.argument.literal)
        : null;

      if (specifier) {
        addImport(specifier, node);
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const specifier = stringLiteralValue(node.arguments[0]);

      if (specifier) {
        addImport(specifier, node);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return imports;
}

function buildLineStarts(sourceText: string): number[] {
  const starts = [0];

  for (let index = 0; index < sourceText.length; index += 1) {
    if (sourceText.codePointAt(index) === 10) {
      starts.push(index + 1);
    }
  }

  return starts;
}

function getLine(lineStarts: number[], pos: number): number {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low < high) {
    const mid = (low + high + 1) >> 1;

    if (lineStarts[mid] <= pos) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return low + 1;
}

function createImportRecord(options: {
  filePath: string;
  lineOffset: number;
  lineStarts: number[];
  pos: number;
  specifier: string;
}): ImportRecord {
  return {
    filePath: options.filePath,
    line: options.lineOffset + getLine(options.lineStarts, options.pos),
    specifier: options.specifier,
  };
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
    (quote === 34 || quote === 39)
  ) {
    return text.slice(1, -1);
  }

  return null;
}

function collectImportTypeRecords(options: {
  filePath: string;
  lineOffset: number;
  lineStarts: number[];
  node: unknown;
  records: ImportRecord[];
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
          lineOffset: options.lineOffset,
          lineStarts: options.lineStarts,
          pos: source.start,
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

function getOxcParseFileName(filePath: string): string {
  const extension = path.extname(filePath);

  return extension === '.vue' || extension === '' ? `${filePath}.ts` : filePath;
}

function collectImportsFromSourceTextWithOxc(options: {
  filePath: string;
  lineOffset?: number;
  sourceText: string;
}): ImportRecord[] | null {
  if (!importOrExportKeywordRE.test(options.sourceText)) {
    return [];
  }

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

  const imports: ImportRecord[] = [];
  const lineStarts = buildLineStarts(options.sourceText);
  const lineOffset = options.lineOffset ?? 0;

  for (const staticImport of parseResult.module.staticImports) {
    imports.push(
      createImportRecord({
        filePath: options.filePath,
        lineOffset,
        lineStarts,
        pos: staticImport.moduleRequest.start,
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
          lineOffset,
          lineStarts,
          pos: entry.moduleRequest.start,
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
        lineOffset,
        lineStarts,
        pos: dynamicImport.moduleRequest.start,
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
  });

  return imports;
}

function collectImportsFromSourceText(options: {
  filePath: string;
  lineOffset?: number;
  scriptKind: ts.ScriptKind;
  sourceText: string;
}): ImportRecord[] {
  const oxcImports = collectImportsFromSourceTextWithOxc(options);

  if (oxcImports) {
    return oxcImports;
  }

  return collectImportsFromSourceTextWithTypeScript(options);
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
  const lang = getHtmlAttributeValue(attrs, 'lang');

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
        sourceText: content,
      }),
    );
  }

  return imports;
}

function pathHasExtension(value: string): boolean {
  return path.extname(value).length > 0;
}

function candidatePathsForBasePath(
  basePath: string,
  extensions: string[],
): string[] {
  if (pathHasExtension(basePath)) {
    return [basePath];
  }

  return extensions.flatMap((extension) => [
    `${basePath}${extension}`,
    path.join(basePath, `index${extension}`),
  ]);
}

function resolveCandidatePath(candidatePath: string): string | null {
  if (!existsSync(candidatePath)) {
    return null;
  }

  if (!statSync(candidatePath).isFile()) {
    return null;
  }

  return normalizeAbsolutePath(candidatePath);
}

function isRelativeSpecifier(specifier: string): boolean {
  return (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  );
}

function resolveRelativeModuleCandidate(options: {
  containingFile: string;
  extensions: string[];
  specifier: string;
}): string | null {
  if (!isRelativeSpecifier(options.specifier)) {
    return null;
  }

  const resolvedSpecifierPath = path.resolve(
    path.dirname(options.containingFile),
    options.specifier,
  );

  for (const candidatePath of candidatePathsForBasePath(
    resolvedSpecifierPath,
    options.extensions,
  )) {
    const resolvedPath = resolveCandidatePath(candidatePath);

    if (resolvedPath) {
      return resolvedPath;
    }
  }

  return null;
}

function matchPathPattern(pattern: string, specifier: string): string | null {
  const wildcardIndex = pattern.indexOf('*');

  if (wildcardIndex === -1) {
    return pattern === specifier ? '' : null;
  }

  const prefix = pattern.slice(0, wildcardIndex);
  const suffix = pattern.slice(wildcardIndex + 1);

  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
    return null;
  }

  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function applyPathPattern(pattern: string, matchedText: string): string {
  return pattern.includes('*') ? pattern.replace('*', matchedText) : pattern;
}

function getPathsBasePath(compilerOptions: ts.CompilerOptions): string | null {
  const pathsBasePath = (compilerOptions as { pathsBasePath?: unknown })
    .pathsBasePath;

  if (typeof pathsBasePath === 'string') {
    return pathsBasePath;
  }

  return compilerOptions.baseUrl ?? null;
}

function resolvePathMappedModuleCandidate(options: {
  compilerOptions: ts.CompilerOptions;
  extensions: string[];
  specifier: string;
}): string | null {
  const paths = options.compilerOptions.paths;
  const pathsBasePath = getPathsBasePath(options.compilerOptions);

  if (!paths || !pathsBasePath) {
    return null;
  }

  const pathEntries = Object.entries(paths).sort(([left], [right]) => {
    const leftPrefixLength = left.split('*')[0]?.length ?? left.length;
    const rightPrefixLength = right.split('*')[0]?.length ?? right.length;

    return rightPrefixLength - leftPrefixLength;
  });

  for (const [alias, targets] of pathEntries) {
    const matchedText = matchPathPattern(alias, options.specifier);

    if (matchedText === null) {
      continue;
    }

    for (const target of targets) {
      const resolvedTargetPath = path.resolve(
        pathsBasePath,
        applyPathPattern(target, matchedText),
      );

      for (const candidatePath of candidatePathsForBasePath(
        resolvedTargetPath,
        options.extensions,
      )) {
        const resolvedPath = resolveCandidatePath(candidatePath);

        if (resolvedPath) {
          return resolvedPath;
        }
      }
    }
  }

  return null;
}

function resolveBaseUrlModuleCandidate(options: {
  compilerOptions: ts.CompilerOptions;
  extensions: string[];
  specifier: string;
}): string | null {
  if (
    isRelativeSpecifier(options.specifier) ||
    !options.compilerOptions.baseUrl
  ) {
    return null;
  }

  const baseUrlPath = path.resolve(
    options.compilerOptions.baseUrl,
    options.specifier,
  );

  for (const candidatePath of candidatePathsForBasePath(
    baseUrlPath,
    options.extensions,
  )) {
    const resolvedPath = resolveCandidatePath(candidatePath);

    if (resolvedPath) {
      return resolvedPath;
    }
  }

  return null;
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
        extensions: contextOrExtensions.extensions,
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

function getConditionNames(compilerOptions: ts.CompilerOptions): string[] {
  return [
    ...new Set([
      ...(compilerOptions.customConditions ?? []),
      'import',
      'require',
      'node',
      'default',
    ]),
  ];
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
  extensions: string[];
}): NapiResolveOptions {
  return {
    conditionNames: getConditionNames(options.compilerOptions),
    extensionAlias,
    extensions: options.extensions,
    nodePath: false,
    symlinks: options.compilerOptions.preserveSymlinks !== true,
    tsconfig: 'auto',
  };
}

function createResolverCacheKey(options: {
  compilerOptions: ts.CompilerOptions;
  extensions: string[];
}): string {
  return JSON.stringify({
    conditions: getConditionNames(options.compilerOptions),
    extensions: options.extensions,
    preserveSymlinks: options.compilerOptions.preserveSymlinks === true,
  });
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

export function createImportAnalysisContext(): ImportAnalysisContext {
  const sourceTextCache = new Map<string, string>();
  const importsCache = new Map<string, ImportRecord[]>();
  const resolverCache = new Map<string, ResolverFactory>();
  const resolutionCache = new Map<string, string | null>();

  const readSourceText = (filePath: string): string => {
    if (!sourceTextCache.has(filePath)) {
      sourceTextCache.set(filePath, readFileSync(filePath, 'utf8'));
    }

    return sourceTextCache.get(filePath)!;
  };

  const collectImportsFromFile = (filePath: string): ImportRecord[] => {
    const normalizedFilePath = normalizeAbsolutePath(filePath);
    const cached = importsCache.get(normalizedFilePath);

    if (cached) {
      return cached;
    }

    const sourceText = readSourceText(normalizedFilePath);
    const imports = normalizedFilePath.endsWith('.vue')
      ? collectVueImportsFromSourceText({
          filePath: normalizedFilePath,
          sourceText,
        })
      : collectImportsFromSourceText({
          filePath: normalizedFilePath,
          scriptKind: getSourceFileKind(normalizedFilePath),
          sourceText,
        });

    importsCache.set(normalizedFilePath, imports);
    return imports;
  };

  const resolveWithOxc = (options: {
    compilerOptions: ts.CompilerOptions;
    containingFile: string;
    extensions: string[];
    specifier: string;
  }): string | null => {
    const resolverCacheKey = createResolverCacheKey(options);
    const resolver =
      resolverCache.get(resolverCacheKey) ??
      new ResolverFactory(createResolverOptions(options));

    resolverCache.set(resolverCacheKey, resolver);

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
  };

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
      specifier,
    });
    const cached = resolutionCache.get(cacheKey);

    if (cached !== undefined) {
      return cached;
    }

    const preferTypeScriptResolver =
      hasTypeScriptOnlyResolutionOptions(options);
    const typeScriptResolved = preferTypeScriptResolver
      ? resolveModuleNameWithCheckers({
          compilerOptions: options,
          containingFile: normalizedContainingFile,
          context,
          specifier,
        })
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
        : (resolveWithOxc({
            compilerOptions: options,
            containingFile: normalizedContainingFile,
            extensions,
            specifier,
          }) ??
          resolveModuleNameWithCheckers({
            compilerOptions: options,
            containingFile: normalizedContainingFile,
            context,
            specifier,
          })));

    resolutionCache.set(cacheKey, resolved);
    return resolved;
  };

  return {
    collectImportsFromFile,
    resolveInternalImport,
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
