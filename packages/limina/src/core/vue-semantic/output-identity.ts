import type { VueProjectSemanticIdentity } from '#checkers';
import type ts from 'typescript';
import { analysisHash } from '../analysis-cache/identity';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import { withVueDeclarationLoading } from './loading-identity';

// Keep source membership and toolchain authority while observing output options.
export function createVueOutputIdentity(
  source: VueProjectSemanticIdentity,
  output: {
    configPath: string;
    options: ts.CompilerOptions;
    fileNames: readonly string[];
  },
): VueProjectSemanticIdentity {
  const identity = {
    ...source,
    declarationBaseId: undefined,
    declarationLoading: undefined,
    outputSourceConfigPath: source.configPath,
    configPath: output.configPath,
    options: output.options,
    fileNames: output.fileNames,
    projectReferences: undefined,
    id: analysisHash([
      source.declarationBaseId ?? source.id,
      output.configPath,
      effectiveCompilerOptions(output.options),
      output.fileNames,
    ]),
  };
  return source.declarationLoading === undefined
    ? identity
    : withVueDeclarationLoading(identity, source.declarationLoading);
}
