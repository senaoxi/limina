import type ts from 'typescript';

export function cloneCompilerOptions(
  options: ts.CompilerOptions,
  overrides?: Partial<ts.CompilerOptions>,
): ts.CompilerOptions {
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(options),
      ...Object.getOwnPropertyDescriptors(overrides ?? {}),
    },
  );
}
