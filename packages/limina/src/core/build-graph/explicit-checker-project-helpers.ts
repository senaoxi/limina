import {
  type CheckerProjectConfigCache,
  type CheckerProjectParseContext,
  isBuildCapablePreset,
} from '#checkers';
import type { CheckerName } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import type { AutoScopeProject } from './types';

export function getScopedParseContext(
  checkerName: CheckerName,
): CheckerProjectParseContext {
  if (isBuildCapablePreset(checkerName)) {
    return { checkerPresets: [checkerName], extensions: [] };
  }
  return {
    checkerPresets: ['tsc'],
    extensions: [checkerName === 'astro' ? '.astro' : '.svelte'],
  };
}

export function getExplicitAnalysisGeneration(
  cache?: CheckerProjectConfigCache,
): number {
  return cache === undefined ? 0 : cache.generation;
}

export function getVueProfileFileNames(
  identity: CheckerProjectParseContext['vueSemanticIdentity'],
): string[] {
  return identity === undefined
    ? []
    : identity.profilesByFileName.keys().toArray();
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
  ].sort(compareCodeUnits);
}
