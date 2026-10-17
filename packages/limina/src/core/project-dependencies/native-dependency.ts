import type { ImportRecord } from '../import-analysis/records';
import type { NativeDependencyFact } from '../typescript-semantic/dependency-fact';
import type { ProjectDependencyRequest } from './contracts';
import { isTypeScriptSemanticSource } from './source-evidence';

export function getDirectNativeFact(options: {
  importRecord: ImportRecord;
  request: ProjectDependencyRequest;
}): NativeDependencyFact | undefined {
  const context = isNativeRequest(options)
    ? options.request.typeScriptSemanticContext
    : undefined;
  return context?.getDependencyFact(options.importRecord);
}

function isNativeRequest(options: {
  importRecord: ImportRecord;
  request: ProjectDependencyRequest;
}): boolean {
  return (
    options.request.context.semanticAuthority.family !== 'vue' &&
    isTypeScriptSemanticSource(options.importRecord.filePath)
  );
}

export function getNativeTargetPath(
  fact: NativeDependencyFact,
): string | undefined {
  return fact.resolution.target?.resolvedFileName;
}
