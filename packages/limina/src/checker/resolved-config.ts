import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import {
  resolveCachedConfig,
  type ResolvedConfigCodec,
} from '#utils/resolved-config-cache';
import { isPlainRecord } from '#utils/values';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import type {
  CheckerConfigClosureEntry,
  CheckerProjectConfigParseOptions,
} from './types';

export interface ResolvedConfigProjection {
  configClosure: CheckerConfigClosureEntry[];
  parsed: ts.ParsedCommandLine;
  extendsDeclarations: { configPath: string; values: string[] }[];
  vueOptionsPath: string | null;
  configuredVueExtensions: string[];
}

export function resolveConfigProjection<T>(
  options: CheckerProjectConfigParseOptions,
  configClosure: readonly string[],
  parse: () => T,
  codec: ResolvedConfigCodec<T>,
): T {
  if (options.virtualFiles?.size) return parse();
  return resolveCachedConfig(
    {
      configPath: normalizeAbsolutePath(options.configPath),
      context: JSON.stringify([
        'ownership-intent',
        ts.version,
        ts.sys.getCurrentDirectory(),
        ts.sys.useCaseSensitiveFileNames,
        options.allowNoInputDiagnostics === true,
      ]),
    },
    configClosure,
    parse,
    codec,
  );
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
    if (raw === undefined || !paths.has(path)) continue;
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
  return {
    configClosure,
    parsed,
    extendsDeclarations,
    configuredVueExtensions: [...new Set(extensions.values().toArray().flat())],
    vueOptionsPath,
  };
}
