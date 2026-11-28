import ts from 'typescript';
import { NATIVE_PROGRAM_ADAPTER } from './native-program-api';

import {
  compilerPathPolicy,
  type CompilerPathPolicy,
  type PathHost,
} from '#utils/compiler-path-policy';
export { compilerPathPolicy } from '#utils/compiler-path-policy';

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
