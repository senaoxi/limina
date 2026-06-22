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

export function matchPathPattern(
  pattern: string,
  specifier: string,
): string | null {
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

  for (const candidatePath of candidatePathsForBasePath(
    resolvedSpecifierPath,
    options.extensions,
  )) {
    const resolvedPath = resolveExistingFilePath(candidatePath);

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
        const resolvedPath = resolveExistingFilePath(candidatePath);

        if (resolvedPath) {
          return resolvedPath;
        }
      }
    }
  }

  return null;
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

  const baseUrlPath = path.resolve(
    options.compilerOptions.baseUrl,
    options.specifier,
  );

  for (const candidatePath of candidatePathsForBasePath(
    baseUrlPath,
    options.extensions,
  )) {
    const resolvedPath = resolveExistingFilePath(candidatePath);

    if (resolvedPath) {
      return resolvedPath;
    }
  }

  return null;
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
