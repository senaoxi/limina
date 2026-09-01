import {
  resolveCheckerSourceModuleName,
  type ResolvedCheckerModuleName,
} from '#checkers';
import type { ImportRecord } from './records';
import type { ProviderDependencies } from './resolution-provider-types';
import { resolveTypeScriptResult } from './resolution-results';
import type { NormalizedModuleResolutionRequest } from './types';

function resolveCheckerSourceTarget(
  request: NormalizedModuleResolutionRequest,
) {
  return resolveCheckerSourceModuleName({
    compilerOptions: request.compilerOptions,
    containingFile: request.containingFile,
    extensions: request.context.extensions,
    specifier: request.specifier,
  });
}

export function resolveNativeTypeScriptTarget(options: {
  dependencies: ProviderDependencies;
  importRecord: ImportRecord;
  request: NormalizedModuleResolutionRequest;
}): ResolvedCheckerModuleName | null {
  const semanticContext = options.request.context.typeScriptSemanticContext;
  if (semanticContext === undefined) {
    return resolveTypeScriptResult(options.dependencies, options.request);
  }
  const target = semanticContext.resolveImportRecord(
    options.importRecord,
  ).target;
  if (target !== null) return target;
  return resolveCheckerSourceTarget(options.request);
}
