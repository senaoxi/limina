import path from 'pathe';
import type ts from 'typescript';

/**
 * Parsed paths retain their declaration's base independently of configFilePath.
 */
export function absoluteCompilerPaths(
  options: ts.CompilerOptions,
): ts.MapLike<string[]> | undefined {
  if (options.paths === undefined) return undefined;
  const base = options.baseUrl ?? options.pathsBasePath;
  if (typeof base !== 'string')
    throw new Error('Parsed paths have no compiler base directory.');
  return Object.fromEntries(
    Object.entries(options.paths).map(([name, entries]) => [
      name,
      entries.map((entry) => path.resolve(base, entry)),
    ]),
  );
}

export function canImportTsExtensions(options: ts.CompilerOptions): boolean {
  // TypeScript computes this permission from both options, including explicit false.
  return Boolean(
    options.allowImportingTsExtensions ||
      options.rewriteRelativeImportExtensions,
  );
}

// Parsed configuration syntax is observed through the configuration closure.
// It is not a compiler option and must not enter persistent identities or DTOs.
export function effectiveCompilerOptions(
  options: ts.CompilerOptions,
): ts.CompilerOptions {
  return Object.fromEntries(
    Object.entries(options).filter(
      ([key, value]) => key !== 'configFile' && value !== undefined,
    ),
  );
}
