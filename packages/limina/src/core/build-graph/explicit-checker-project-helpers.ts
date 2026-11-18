import {
  type CheckerProjectParseContext,
  isBuildCapablePreset,
} from '#checkers';
import type { CheckerName } from '#config/runner';

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
