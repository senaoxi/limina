import type ts from 'typescript';

export type PathHost = Pick<
  ts.CompilerHost,
  'getCurrentDirectory' | 'getCanonicalFileName'
>;
type PathCompiler = typeof ts & {
  toPath(
    file: string,
    directory: string,
    canonicalize: (file: string) => string,
  ): string;
};

/**
Capture the actual Host policy once; physical identity is never a path key.
*/
export interface CompilerPathPolicy {
  readonly key: (file: string) => string;
  readonly identity: string;
}

export function compilerPathPolicy(
  compiler: typeof ts,
  host: PathHost,
): CompilerPathPolicy {
  const directory = host.getCurrentDirectory();
  const canonicalize = host.getCanonicalFileName;
  const key = (file: string) =>
    (compiler as PathCompiler).toPath(file, directory, canonicalize);
  return {
    key,
    identity: JSON.stringify([
      'typescript.toPath-v1',
      compiler.version,
      directory,
      canonicalize('Aa/BB.ts'),
      canonicalize('aa/bb.ts'),
    ]),
  };
}
