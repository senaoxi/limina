import {
  deriveNativeCoverage,
  type NativeCoverage,
  type NativeFileIdentity,
  type SourceConfigCoverageIndex,
} from '../../domain/analysis/native-coverage';
import { nativeCompilerPathPolicy } from './compiler-path-key';

/**
Compiler keys preserve aliases; only the compiler host's case policy folds names.
*/
export const compilerFileKey = (file: string): string =>
  nativeCompilerPathPolicy().key(file);

export function deriveCompilerCoverage(
  index: SourceConfigCoverageIndex,
  target: NativeFileIdentity,
  fileKey: (file: string) => string = nativeCompilerPathPolicy().key,
): NativeCoverage {
  return deriveNativeCoverage(index, target, fileKey);
}
