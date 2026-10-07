import type ts from 'typescript';

// Parsed configuration syntax is observed through the configuration closure.
// It is not a compiler option and must not enter persistent identities or DTOs.
export function effectiveCompilerOptions(
  options: ts.CompilerOptions,
): ts.CompilerOptions {
  return Object.fromEntries(
    Object.entries(options).filter(([key]) => key !== 'configFile'),
  );
}
