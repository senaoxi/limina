import type ts from 'typescript';

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
