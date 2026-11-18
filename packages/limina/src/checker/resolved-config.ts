import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import {
  resolveCachedConfig,
  type ResolvedConfigCodec,
} from '#utils/resolved-config-cache';
import { isPlainRecord } from '#utils/values';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { z } from 'zod';
import type {
  CheckerConfigClosureEntry,
  CheckerProjectConfigParseOptions,
} from './types';

const strings = z.array(z.string());
const closureEntry = z.strictObject({
  filePath: z.string(),
  contentHash: z.string().regex(/^[a-f\d]{64}$/u),
});
const reference = z.strictObject({
  path: z.string(),
  originalPath: z.string().optional(),
  prepend: z.boolean().optional(),
  circular: z.boolean().optional(),
});

const selectors = z.strictObject({
  files: strings.optional(),
  include: strings.optional(),
  exclude: strings.optional(),
});
const parsedProjection = z.strictObject({
  fileNames: strings,
  options: z.record(z.string(), z.json()),
  projectReferences: z.array(reference).optional(),
  raw: selectors,
});
const declaration = z.strictObject({ configPath: z.string(), values: strings });
// These fields accompany the parsed root in supported TS 5.4–6.0 compilers.
// A change to this private shape disables projection replay for that compiler.
const optionalSelectors = strings.optional();
const configFileSpecs = z.strictObject({
  filesSpecs: optionalSelectors,
  includeSpecs: optionalSelectors,
  excludeSpecs: optionalSelectors,
  validatedFilesSpec: optionalSelectors,
  validatedIncludeSpecs: optionalSelectors,
  validatedExcludeSpecs: optionalSelectors,
  validatedFilesSpecBeforeSubstitution: optionalSelectors,
  validatedIncludeSpecsBeforeSubstitution: optionalSelectors,
  validatedExcludeSpecsBeforeSubstitution: optionalSelectors,
  isDefaultIncludeSpec: z.boolean(),
});
const configSyntax = z.strictObject({
  fileName: z.string(),
  text: z.string(),
  extendedSourceFiles: strings.optional(),
  path: z.string(),
  resolvedPath: z.string(),
  originalFileName: z.string(),
  configFileSpecs,
});
const projection = z.strictObject({
  configClosure: z.array(closureEntry).min(1),
  parsed: parsedProjection,
  extendsDeclarations: z.array(declaration),
  vueOptionsPath: z.string().nullable(),
  configuredVueExtensions: strings,
  syntax: configSyntax,
});

// Only the data consumed by Limina crosses processes. In particular,
// ts.CompilerOptions.configFile links into a live, cyclic compiler AST.
export interface ResolvedConfigProjection {
  configClosure: CheckerConfigClosureEntry[];
  parsed: {
    fileNames: string[];
    options: ts.CompilerOptions;
    projectReferences?: readonly ts.ProjectReference[];
    raw: { files?: string[]; include?: string[]; exclude?: string[] };
  };
  extendsDeclarations: { configPath: string; values: string[] }[];
  vueOptionsPath: string | null;
  configuredVueExtensions: string[];
}

export function resolveConfigProjection<T>(
  role: 'command-line' | 'ownership-intent',
  options: CheckerProjectConfigParseOptions,
  extraExtensions: readonly ts.FileExtensionInfo[] | undefined,
  parse: () => T,
  codec: ResolvedConfigCodec<T>,
): T {
  if (options.virtualFiles?.size) return parse();
  return resolveCachedConfig(
    {
      configPath: normalizeAbsolutePath(options.configPath),
      context: JSON.stringify([
        role,
        ts.version,
        ts.sys.getCurrentDirectory(),
        ts.sys.useCaseSensitiveFileNames,
        options.allowNoInputDiagnostics === true,
        extraExtensions ?? [],
      ]),
    },
    parse,
    codec,
  );
}

function hasCompleteClosure(
  configPath: string,
  value: z.infer<typeof projection>,
): boolean {
  const paths = new Set(value.configClosure.map((entry) => entry.filePath));
  const expected = new Set([
    normalizeAbsolutePath(configPath),
    ...(value.syntax.extendedSourceFiles ?? []).map(normalizeAbsolutePath),
  ]);
  return (
    paths.size === value.configClosure.length &&
    paths.size === expected.size &&
    expected.values().every((path) => paths.has(path)) &&
    normalizeAbsolutePath(value.syntax.fileName) ===
      normalizeAbsolutePath(configPath) &&
    value.extendsDeclarations.every((entry) => paths.has(entry.configPath)) &&
    (value.vueOptionsPath === null || paths.has(value.vueOptionsPath))
  );
}

function captureSyntax(source: unknown) {
  if (!isPlainRecord(source) || !isPlainRecord(source.configFileSpecs))
    return null;
  const specs = Object.fromEntries(
    Object.entries(source.configFileSpecs).filter(
      ([, value]) => value !== undefined,
    ),
  );
  return configSyntax.safeParse({
    fileName: source.fileName,
    text: source.text,
    path: source.path,
    resolvedPath: source.resolvedPath,
    originalFileName: source.originalFileName,
    extendedSourceFiles: source.extendedSourceFiles,
    configFileSpecs: specs,
  }).data;
}

function restoreProjection(
  record: z.infer<typeof projection>,
): ResolvedConfigProjection {
  const { syntax, ...value } = record;
  // Construct the root syntax only if a Compiler API consumer requests it.
  // Inherited edges and file membership are already resolved by TypeScript.
  let configFile: ts.TsConfigSourceFile | undefined;
  Object.defineProperty(value.parsed.options, 'configFile', {
    enumerable: false,
    get() {
      if (configFile === undefined) {
        const { text, fileName, ...metadata } = syntax;
        configFile = Object.assign(
          ts.readJsonConfigFile(fileName, () => text),
          metadata,
        );
      }
      return configFile;
    },
  });
  return value as ResolvedConfigProjection;
}

export function parsedConfigCodec(
  configPath: string,
): ResolvedConfigCodec<ResolvedConfigProjection> {
  return {
    requiredFiles: (value) =>
      value.configClosure.map(({ filePath }) => filePath),
    encode(value) {
      // TS attaches configFile as a non-enumerable option. Its syntax is used by
      // the resolver (including package imports mapped back from outDir).
      const syntax = captureSyntax(value.parsed.options.configFile);
      return syntax ? JSON.stringify({ ...value, syntax }) : undefined;
    },
    decode(payload) {
      const result = projection.safeParse(JSON.parse(payload));
      return result.success && hasCompleteClosure(configPath, result.data)
        ? restoreProjection(result.data)
        : undefined;
    },
  };
}

function stringEntries(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export function projectResolvedConfig(
  configPath: string,
  parsed: ts.ParsedCommandLine,
  extended: ReadonlyMap<string, ts.ExtendedConfigCacheEntry>,
  content: ReadonlyMap<string, string>,
): ResolvedConfigProjection {
  const declarations = new Map<string, Record<string, unknown>>([
    [normalizeAbsolutePath(configPath), parsed.raw],
  ]);
  for (const { extendedResult, extendedConfig } of extended.values()) {
    declarations.set(
      normalizeAbsolutePath(extendedResult.fileName),
      extendedConfig!.raw,
    );
  }
  const configClosure = Array.from(declarations.keys(), (filePath) => {
    const text = content.get(filePath);
    if (text === undefined)
      throw new Error(
        `Parsed TypeScript config closure entry is unreadable: ${filePath}`,
      );
    return {
      filePath,
      contentHash: createHash('sha256').update(text).digest('hex'),
    };
  }).sort((a, b) => compareCodeUnits(a.filePath, b.filePath));
  const extendsDeclarations = [];
  const extensions = new Map<string, string[]>();
  let vueOptionsPath: string | null = null;
  // @vue/language-core applies bases in reverse compiler read order, then the leaf.
  for (const path of content.keys().toArray().toReversed()) {
    const raw = declarations.get(path);
    if (raw === undefined) continue;
    const values =
      typeof raw.extends === 'string'
        ? [raw.extends]
        : stringEntries(raw.extends);
    if (values.length > 0)
      extendsDeclarations.push({ configPath: path, values });
    if (!Object.hasOwn(raw, 'vueCompilerOptions')) continue;
    const vue = raw.vueCompilerOptions;
    vueOptionsPath = isPlainRecord(vue) ? path : null;
    if (!isPlainRecord(vue)) continue;
    for (const key of [
      'extensions',
      'petiteVueExtensions',
      'vitePressExtensions',
    ]) {
      if (Array.isArray(vue[key])) extensions.set(key, stringEntries(vue[key]));
    }
  }
  const { files, include, exclude } = parsed.raw;
  return {
    configClosure,
    parsed: {
      fileNames: parsed.fileNames,
      options: parsed.options,
      projectReferences: parsed.projectReferences,
      raw: { files, include, exclude },
    },
    extendsDeclarations,
    configuredVueExtensions: [...new Set(extensions.values().toArray().flat())],
    vueOptionsPath,
  };
}
