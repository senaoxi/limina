import { existsSync, statSync } from 'node:fs';
import path from 'pathe';
import type ts from 'typescript';

import { isRelativeSpecifier } from './module-specifier';
import { normalizeAbsolutePath } from './path';

export interface ModuleCandidateResolveOptions {
  containingFile: string;
  extensions: readonly string[];
  specifier: string;
}

export interface TypeScriptModuleCandidateResolveOptions {
  compilerOptions: ts.CompilerOptions;
  extensions: readonly string[];
  specifier: string;
}

export function pathHasExtension(value: string): boolean {
  return path.extname(value).length > 0;
}

export function candidatePathsForBasePath(
  basePath: string,
  extensions: readonly string[],
): string[] {
  if (pathHasExtension(basePath)) {
    return [basePath];
  }

  return extensions.flatMap((extension) => [
    `${basePath}${extension}`,
    path.join(basePath, `index${extension}`),
  ]);
}

export function resolveExistingFilePath(candidatePath: string): string | null {
  if (!existsSync(candidatePath)) {
    return null;
  }

  if (!statSync(candidatePath).isFile()) {
    return null;
  }

  return normalizeAbsolutePath(candidatePath);
}

function matchExactPathPattern(
  pattern: string,
  specifier: string,
): string | null {
  return pattern === specifier ? '' : null;
}

function matchesWildcardBounds(
  specifier: string,
  prefix: string,
  suffix: string,
): boolean {
  return [specifier.startsWith(prefix), specifier.endsWith(suffix)].every(
    Boolean,
  );
}

function matchWildcardPathPattern(
  pattern: string,
  specifier: string,
  wildcardIndex: number,
): string | null {
  const prefix = pattern.slice(0, wildcardIndex);
  const suffix = pattern.slice(wildcardIndex + 1);

  if (!matchesWildcardBounds(specifier, prefix, suffix)) {
    return null;
  }

  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

export function matchPathPattern(
  pattern: string,
  specifier: string,
): string | null {
  const wildcardIndex = pattern.indexOf('*');

  return wildcardIndex === -1
    ? matchExactPathPattern(pattern, specifier)
    : matchWildcardPathPattern(pattern, specifier, wildcardIndex);
}

function resolveFirstExistingCandidate(
  basePath: string,
  extensions: readonly string[],
): string | null {
  for (const candidatePath of candidatePathsForBasePath(basePath, extensions)) {
    const resolvedPath = resolveExistingFilePath(candidatePath);

    if (resolvedPath) {
      return resolvedPath;
    }
  }

  return null;
}

export function resolveRelativeModuleCandidate(
  options: ModuleCandidateResolveOptions,
): string | null {
  if (!isRelativeSpecifier(options.specifier)) {
    return null;
  }

  const resolvedSpecifierPath = path.resolve(
    path.dirname(options.containingFile),
    options.specifier,
  );

  return resolveFirstExistingCandidate(
    resolvedSpecifierPath,
    options.extensions,
  );
}

function getPathPrefixLength(pattern: string): number {
  const prefix = pattern.split('*')[0];

  return prefix === undefined ? pattern.length : prefix.length;
}

function comparePathEntriesBySpecificity(
  [left]: [string, string[]],
  [right]: [string, string[]],
): number {
  return getPathPrefixLength(right) - getPathPrefixLength(left);
}

function resolveMappedTargets(options: {
  extensions: readonly string[];
  matchedText: string;
  pathsBasePath: string;
  targets: readonly string[];
}): string | null {
  for (const target of options.targets) {
    const resolvedPath = resolveFirstExistingCandidate(
      path.resolve(
        options.pathsBasePath,
        applyPathPattern(target, options.matchedText),
      ),
      options.extensions,
    );

    if (resolvedPath) {
      return resolvedPath;
    }
  }

  return null;
}

function resolvePathEntry(
  [alias, targets]: [string, string[]],
  options: TypeScriptModuleCandidateResolveOptions,
  pathsBasePath: string,
): string | null {
  const matchedText = matchPathPattern(alias, options.specifier);

  if (matchedText === null) {
    return null;
  }

  return resolveMappedTargets({
    extensions: options.extensions,
    matchedText,
    pathsBasePath,
    targets,
  });
}

function resolvePathEntries(
  entries: [string, string[]][],
  options: TypeScriptModuleCandidateResolveOptions,
  pathsBasePath: string,
): string | null {
  for (const entry of entries) {
    const resolvedPath = resolvePathEntry(entry, options, pathsBasePath);

    if (resolvedPath) {
      return resolvedPath;
    }
  }

  return null;
}

export function resolvePathMappedModuleCandidate(
  options: TypeScriptModuleCandidateResolveOptions,
): string | null {
  const paths = options.compilerOptions.paths;
  const pathsBasePath = getPathsBasePath(options.compilerOptions);

  if (!paths || !pathsBasePath) {
    return null;
  }

  const entries = Object.entries(paths).sort(comparePathEntriesBySpecificity);

  return resolvePathEntries(entries, options, pathsBasePath);
}

export function resolveBaseUrlModuleCandidate(
  options: TypeScriptModuleCandidateResolveOptions,
): string | null {
  if (
    isRelativeSpecifier(options.specifier) ||
    !options.compilerOptions.baseUrl
  ) {
    return null;
  }

  return resolveFirstExistingCandidate(
    path.resolve(options.compilerOptions.baseUrl, options.specifier),
    options.extensions,
  );
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
