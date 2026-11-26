import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { isPlainRecord } from '#utils/values';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { z } from 'zod';
import type { CheckerConfigClosureEntry } from './types';

export interface ResolvedConfigProjection {
  configClosure: CheckerConfigClosureEntry[];
  parsed: ts.ParsedCommandLine;
  configuredVueExtensions: string[];
  rootSelectors: Parameters<typeof ts.sys.readDirectory>[];
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
  rootSelectors: Parameters<typeof ts.sys.readDirectory>[] = [],
): ResolvedConfigProjection {
  const declarations = new Map<string, Record<string, unknown>>([
    [normalizeAbsolutePath(configPath), parsed.raw],
  ]);
  for (const { extendedResult, extendedConfig } of extended.values()) {
    if (extendedConfig !== undefined)
      declarations.set(
        normalizeAbsolutePath(extendedResult.fileName),
        extendedConfig.raw,
      );
  }
  const source = parsed.options.configFile as ts.TsConfigSourceFile | undefined;
  const paths = new Set(
    [configPath, ...(source?.extendedSourceFiles ?? [])].map(
      normalizeAbsolutePath,
    ),
  );
  const configClosure = Array.from(paths, (filePath) => {
    const text = content.get(filePath);
    if (text === undefined)
      throw new Error(
        `Parsed TypeScript config closure entry is unreadable: ${filePath}`,
      );
    let hash: string | undefined;
    return Object.freeze({
      filePath,
      get contentHash() {
        return (hash ??= createHash('sha256').update(text).digest('hex'));
      },
    });
  }).sort((a, b) => compareCodeUnits(a.filePath, b.filePath));
  const extensions = new Map<string, string[]>();
  // @vue/language-core applies bases in reverse compiler read order, then the leaf.
  for (const path of content.keys().toArray().toReversed()) {
    const raw = declarations.get(path);
    if (raw === undefined || !paths.has(path)) continue;
    const vue = raw.vueCompilerOptions;
    if (!isPlainRecord(vue)) continue;
    for (const key of [
      'extensions',
      'petiteVueExtensions',
      'vitePressExtensions',
    ]) {
      if (Array.isArray(vue[key])) extensions.set(key, stringEntries(vue[key]));
    }
  }
  return {
    configClosure,
    parsed,
    configuredVueExtensions: [...new Set(extensions.values().toArray().flat())],
    rootSelectors,
  };
}

const text = z.string();
const texts = z.array(text);
const json = z.json();
const number = z.number();
const boolean = z.boolean();
const jsonObject = z.record(text, json);
const reference = z.strictObject({
  path: text,
  originalPath: text.optional(),
  prepend: boolean.optional(),
  circular: boolean.optional(),
});
const references = z.array(reference);
const optionArrayItem = z.union([text, number]);
const plugin = z.looseObject({ name: text }).catchall(json);
const compilerOption = z.union([
  text,
  number,
  boolean,
  z.null(),
  z.array(optionArrayItem),
  z.record(text, texts),
  references,
  z.array(plugin),
]);
const compilerOptions = z.record(text, compilerOption.optional());
const sourceMetadata = z.strictObject({
  fileName: text,
  path: text,
  resolvedPath: text,
  originalFileName: text,
  extendedSourceFiles: texts.optional(),
  configFileSpecs: z.record(text, json.optional()),
});
const configClosureEntry = z.strictObject({
  filePath: text,
  contentHash: text,
});
const rootSelector = z.tuple([
  text,
  texts.nullable(),
  texts.nullable(),
  texts.nullable(),
  number.nullable(),
]);
const typeAcquisition = z.strictObject({
  enable: boolean.optional(),
  include: texts.optional(),
  exclude: texts.optional(),
  disableFilenameBasedTypeAcquisition: boolean.optional(),
});
const wildcardDirectories = z.record(text, number);
const commandLine = z.strictObject({
  options: compilerOptions,
  fileNames: texts,
  projectReferences: references.optional(),
  watchOptions: compilerOptions.optional(),
  typeAcquisition: typeAcquisition.optional(),
  raw: jsonObject,
  wildcardDirectories: wildcardDirectories.optional(),
  compileOnSave: boolean.optional(),
});
const projectionData = z.strictObject({
  configClosure: z.array(configClosureEntry),
  configuredVueExtensions: texts,
  rootSelectors: z.array(rootSelector),
  commandLine,
  source: sourceMetadata,
});

export function captureResolvedConfig(
  value: ResolvedConfigProjection,
): Record<string, unknown> | undefined {
  const { parsed, rootSelectors, ...rest } = value;
  const { errors, options, ...commandLine } = parsed;
  const source = options.configFile as ts.TsConfigSourceFile | undefined;
  if (source === undefined || errors.length > 0) return undefined;
  const metadata = (key: string): unknown =>
    Object.getOwnPropertyDescriptor(source, key)?.value;
  const data = projectionData.safeParse({
    ...rest,
    rootSelectors: rootSelectors.map(
      ([root, extensions, exclude, include, depth]) => [
        root,
        extensions ?? null,
        exclude ?? null,
        include ?? null,
        depth ?? null,
      ],
    ),
    commandLine: { ...commandLine, options: { ...options } },
    source: {
      fileName: source.fileName,
      path: metadata('path'),
      resolvedPath: metadata('resolvedPath'),
      originalFileName: metadata('originalFileName'),
      extendedSourceFiles: source.extendedSourceFiles,
      configFileSpecs: metadata('configFileSpecs'),
    },
  });
  return data.success ? data.data : undefined;
}

export function restoreResolvedConfig(
  data: unknown,
  configPath: string,
  readConfig: (file: string) => string | undefined,
): ResolvedConfigProjection | undefined {
  const result = projectionData.safeParse(data);
  if (!result.success) return undefined;
  const { commandLine, source, rootSelectors, ...rest } = result.data;
  if (
    normalizeAbsolutePath(source.fileName) !== configPath ||
    commandLine.options.configFilePath !== configPath
  )
    return undefined;
  const contents = readConfig(source.fileName);
  if (contents === undefined) return undefined;
  const ast = ts.parseJsonText(source.fileName, contents);
  Object.assign(ast, source);
  const options: ts.CompilerOptions = commandLine.options;
  Object.defineProperty(options, 'configFile', { value: ast });
  return {
    ...rest,
    rootSelectors: rootSelectors.map(
      ([root, extensions, excludes, includes, depth]) => [
        root,
        extensions ?? undefined,
        excludes ?? undefined,
        includes ?? undefined,
        depth ?? undefined,
      ],
    ),
    parsed: { ...commandLine, options, errors: [] },
  };
}
