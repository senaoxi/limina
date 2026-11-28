import type { ImportRecord } from '../import-analysis/records';
import type { TypeScriptSemanticDependencyContext } from '../typescript-semantic';
import type { NativeDependencyFact } from '../typescript-semantic/dependency-fact';
import { isModuleImportRecord } from '../typescript-semantic/import-record';
import type { ProjectDependencyRequest } from './contracts';
import { isTypeScriptSemanticSource } from './source-evidence';

export function getDirectNativeFact(options: {
  importRecord: ImportRecord;
  request: ProjectDependencyRequest;
}): NativeDependencyFact | undefined {
  const context = isNativeRequest(options)
    ? options.request.typeScriptSemanticContext
    : undefined;
  if (context === undefined) return undefined;
  return options.request.purpose === 'runtime-source'
    ? matchNativeRuntimeFact(context, options.importRecord)
    : context.getDependencyFact(options.importRecord);
}

export function matchNativeRuntimeFact(
  context: TypeScriptSemanticDependencyContext,
  record: ImportRecord,
): NativeDependencyFact | undefined {
  const matched = context.findDependencyFact?.(record);
  const requestId = matched?.nativeEvidence?.requestId;
  if (matched === undefined || requestId === undefined) return undefined;
  if (matched.resolution.target === null && isModuleImportRecord(record)) {
    const observed = context.nativeEvidence?.resolutions.find(
      (resolution) => resolution.requestId === requestId,
    );
    if (
      observed?.state === 'unavailable' &&
      observed.pathSelection?.state !== 'disabled'
    )
      return undefined;
  }
  return matched;
}

function isNativeRequest(options: {
  importRecord: ImportRecord;
  request: ProjectDependencyRequest;
}): boolean {
  const family = options.request.context.semanticAuthority.family;
  return (
    (options.request.purpose === 'runtime-source'
      ? family === 'typescript'
      : family !== 'vue') &&
    isTypeScriptSemanticSource(options.importRecord.filePath)
  );
}

export function getNativeTargetPath(
  fact: NativeDependencyFact,
): string | undefined {
  return fact.resolution.target?.resolvedFileName;
}
