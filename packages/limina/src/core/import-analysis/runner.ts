import { createImportAnalysisContext } from './context';
import type { ImportRecord } from './records';
import type {
  ImportAnalysisContext,
  StandaloneInternalImportArguments,
} from './types';

export type { ResolvedCheckerModuleName } from '#checkers';
export { createImportAnalysisContext } from './context';
export { resolveModuleNameWithOxc } from './oxc-resolution';
export type { ImportLocator, ImportRecord, ImportRecordKind } from './records';
export { createOxcResolverProfileIdentity } from './resolver-profile';
export type {
  CreateImportAnalysisContextOptions,
  ImportAnalysisContext,
  ImportAnalysisMetricsRecorder,
  ImportResolveContextFields,
  ImportResolveContextInput,
  ModuleResolutionPair,
  OxcResolverProfileIdentity,
} from './types';

export function collectImportsFromFile(
  filePath: string,
  rootDir: string,
  context?: ImportAnalysisContext,
): ImportRecord[] {
  const provider = context ?? createImportAnalysisContext();
  return provider.collectImportsFromFile(filePath, rootDir);
}

export function resolveInternalImport(
  ...args: StandaloneInternalImportArguments
): string | null {
  const [
    specifier,
    containingFile,
    compilerOptions,
    contextOrExtensions,
    analysisContext,
  ] = args;
  const provider = analysisContext ?? createImportAnalysisContext();
  return provider.resolveInternalImport(
    specifier,
    containingFile,
    compilerOptions,
    contextOrExtensions,
  );
}
