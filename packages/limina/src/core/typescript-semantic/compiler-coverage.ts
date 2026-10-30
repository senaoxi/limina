import ts from 'typescript';
import {
  deriveNativeCoverage,
  type NativeCoverage,
  type NativeFileIdentity,
  type SourceConfigCoverageIndex,
} from '../../domain/analysis/native-coverage';
import { isDeclarationFile } from '../import-graph/declaration-classifier';

/**
Compiler keys preserve aliases; only the compiler host's case policy folds names.
*/
export const compilerFileKey: (file: string) => string = ts.createCompilerHost(
  {},
).getCanonicalFileName;

export function deriveCompilerCoverage(
  index: SourceConfigCoverageIndex,
  target: NativeFileIdentity,
): NativeCoverage {
  return deriveNativeCoverage(
    index,
    target,
    isDeclarationFile(target.lexicalPath) ? undefined : compilerFileKey,
  );
}
