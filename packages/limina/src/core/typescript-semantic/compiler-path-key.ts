import ts from 'typescript';
import { NATIVE_PROGRAM_ADAPTER } from './native-program-api';

type PathHost = Pick<
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
interface CompilerPathPolicy {
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

const nativePolicies = new Map<string, CompilerPathPolicy>();

/**
Native Programs use createCompilerHost's current directory and case policy.
*/
export function nativeCompilerPathPolicy(): CompilerPathPolicy {
  const hostPolicy = JSON.stringify([
    ts.sys.getCurrentDirectory(),
    ts.sys.useCaseSensitiveFileNames,
  ]);
  let nativePolicy = nativePolicies.get(hostPolicy);
  if (nativePolicy === undefined) {
    nativePolicy = compilerPathPolicy(ts, ts.createCompilerHost({}));
    nativePolicies.clear();
    nativePolicies.set(hostPolicy, nativePolicy);
  }
  return nativePolicy;
}

export function nativeHostContract(
  compiler: typeof ts = ts,
  host: PathHost = compiler.createCompilerHost({}),
): string {
  return JSON.stringify([
    NATIVE_PROGRAM_ADAPTER,
    compilerPathPolicy(compiler, host).identity,
  ]);
}
