import { type AnalysisRead, withoutAnalysisReads } from '#utils/analysis-input';
import { uniqueCodeUnitSortedStrings } from '#utils/collections';
import {
  isInsideNodeModules,
  isPathInsideDirectory,
  normalizeAbsolutePath,
} from '#utils/path';
import { canonicalProjectedPathSync } from '#utils/physical-file-identity';
import { withoutSourceConfigTextScope } from '#utils/source-config-text';
import path from 'pathe';
import ts from 'typescript';
import type { ResolvedConfigProjection } from './resolved-config';
import type { ConfigRootSelector } from './types';

interface TypeScriptFileMatcherApi {
  getFileMatcherPatterns(
    root: string,
    excludes: readonly string[] | undefined,
    includes: readonly string[] | undefined,
    isCaseSensitive: boolean,
    currentDirectory: string,
  ): { includeFilePatterns?: readonly string[]; excludePattern?: string };
}

const sourceMembership = new WeakMap<ts.TsConfigSourceFile, AnalysisRead>();

function rootNames(files: readonly string[]): string[] {
  return uniqueCodeUnitSortedStrings(
    files
      .map(normalizeAbsolutePath)
      .filter((file) => !isInsideNodeModules(file)),
  );
}

function outputSelectors(selectors: readonly ConfigRootSelector[]) {
  if (selectors.length === 0) return [];
  const api = ts as typeof ts & Partial<TypeScriptFileMatcherApi>;
  if (typeof api.getFileMatcherPatterns !== 'function')
    throw new TypeError('TypeScript config root matcher is unavailable.');
  const { getFileMatcherPatterns } = api;
  const { useCaseSensitiveFileNames } = ts.sys;
  const flags = useCaseSensitiveFileNames ? '' : 'i';
  const currentDirectory = ts.sys.getCurrentDirectory();
  return selectors.map(([root, extensions, excludes, includes]) => {
    const { includeFilePatterns, excludePattern } = getFileMatcherPatterns(
      root,
      excludes,
      includes,
      useCaseSensitiveFileNames,
      currentDirectory,
    );
    const include = includeFilePatterns?.map(
      (pattern) => new RegExp(pattern, flags),
    );
    const exclude =
      excludePattern === undefined
        ? undefined
        : new RegExp(excludePattern, flags);
    return (file: string): boolean =>
      (extensions === undefined ||
        extensions.some((extension) => file.endsWith(extension))) &&
      (include === undefined ||
        include.some((pattern) => pattern.test(file))) &&
      !exclude?.test(file);
  });
}

function outputAliasDirectories({
  parsed,
  rootSelectors,
}: ResolvedConfigProjection): { directory: string; canonical: string }[] {
  const directories = new Set(Object.keys(parsed.wildcardDirectories ?? {}));
  for (const selector of rootSelectors) {
    const root = selector[0];
    const includes = selector[3] ?? [];
    directories.add(root);
    for (const include of includes)
      if (!/[*?]/u.test(include))
        directories.add(path.dirname(path.resolve(root, include)));
  }
  return [...directories].flatMap((name) => {
    const directory = normalizeAbsolutePath(name);
    if (isInsideNodeModules(directory)) return [];
    try {
      const canonical = canonicalProjectedPathSync(directory);
      return canonical === directory ? [] : [{ directory, canonical }];
    } catch {
      return [];
    }
  });
}

export function retainSvelteSourceMembership(
  configPath: string,
  projection: ResolvedConfigProjection,
  read: () => readonly string[],
): void {
  const source = projection.parsed.options.configFile as
    | ts.TsConfigSourceFile
    | undefined;
  if (source === undefined || sourceMembership.has(source)) return;
  const selectors = outputSelectors(projection.rootSelectors);
  const aliases = outputAliasDirectories(projection);
  const canInclude = (file: string) =>
    !isInsideNodeModules(file) && selectors.some((selector) => selector(file));
  sourceMembership.set(source, {
    path: configPath,
    key: JSON.stringify(['svelte-source-membership', configPath]),
    value: rootNames(projection.parsed.fileNames),
    read: () =>
      rootNames(withoutAnalysisReads(() => withoutSourceConfigTextScope(read))),
    membership: {
      mayChangeWith(file) {
        const normalized = normalizeAbsolutePath(file);
        return (
          canInclude(normalized) ||
          aliases.some(
            ({ directory, canonical }) =>
              isPathInsideDirectory(normalized, canonical) &&
              canInclude(
                path.join(directory, path.relative(canonical, normalized)),
              ),
          )
        );
      },
    },
  });
}

export function svelteSourceMembership(
  options: ts.CompilerOptions,
): AnalysisRead | undefined {
  const source = options.configFile as ts.TsConfigSourceFile | undefined;
  return source === undefined ? undefined : sourceMembership.get(source);
}
