import type {
  CheckerProjectConfigCache,
  CheckerProjectParseContext,
} from '#checkers';
import type { CheckerName } from '#config/runner';
import type { AutoScopeProject } from './types';

export function getExplicitAnalysisGeneration(
  cache?: CheckerProjectConfigCache,
): number {
  return cache === undefined ? 0 : cache.generation;
}

export function getVueProfileFileNames(
  identity: CheckerProjectParseContext['vueSemanticIdentity'],
): string[] {
  if (identity === undefined) return [];
  return [...identity.profilesByFileName.keys()];
}

export function addExplicitVueFiles(options: {
  checkerName: CheckerName;
  filePartition: AutoScopeProject['filePartition'];
  profileFileNames: readonly string[];
}): void {
  if (options.checkerName !== 'vue-tsc') return;
  options.filePartition.vueFiles = [
    ...new Set([
      ...options.filePartition.vueFiles,
      ...options.profileFileNames,
    ]),
  ].sort();
}
