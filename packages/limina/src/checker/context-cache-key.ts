import type { CheckerPreset } from '#config/runner';
import { compareCodeUnits, uniqueValues } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { normalizeExtensions } from './extensions';
import type { CheckerProjectParseContext } from './types';

function uniqueSortedPresets(
  presets: readonly CheckerPreset[],
): CheckerPreset[] {
  return uniqueValues([...presets]).sort(compareCodeUnits);
}

export function resolveContextCheckerPresets(
  context: CheckerProjectParseContext,
): CheckerPreset[] {
  if (context.checkerPresets.length > 0) {
    return uniqueSortedPresets(context.checkerPresets);
  }
  return ['tsc'];
}

function getVirtualConfigContent(options: {
  configPath: string;
  virtualFiles?: ReadonlyMap<string, string>;
}): string | undefined {
  if (options.virtualFiles === undefined) return undefined;
  return options.virtualFiles.get(normalizeAbsolutePath(options.configPath));
}

function createVirtualFilesIdentity(
  virtualFiles: ReadonlyMap<string, string> | undefined,
): string | undefined {
  if (virtualFiles === undefined) return undefined;
  const hash = createHash('sha256');
  for (const [filePath, content] of [...virtualFiles.entries()].sort(
    ([left], [right]) => compareCodeUnits(left, right),
  )) {
    hash.update(normalizeAbsolutePath(filePath));
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function getConfigIdentity(options: {
  configPath: string;
  virtualContent: string | undefined;
}): { size: number; time: number | string } {
  if (options.virtualContent !== undefined) {
    return {
      size: options.virtualContent.length,
      time: options.virtualContent,
    };
  }
  const stats = statSync(options.configPath);
  return { size: stats.size, time: stats.mtimeMs };
}

export function createParsedProjectConfigCacheKey(options: {
  allowNoInputDiagnostics?: boolean;
  checkerPresets: CheckerPreset[];
  configPath: string;
  extensions: string[];
  generation: number;
  projectRootDir: string;
  virtualFiles?: ReadonlyMap<string, string>;
  vueSemanticIdentity?: CheckerProjectParseContext['vueSemanticIdentity'];
}): string {
  const virtualContent = getVirtualConfigContent(options);
  const identity = getConfigIdentity({
    configPath: options.configPath,
    virtualContent,
  });
  return JSON.stringify({
    allowNoInputDiagnostics: options.allowNoInputDiagnostics,
    checkerPresets: options.checkerPresets,
    configPath: normalizeAbsolutePath(options.configPath),
    configSize: identity.size,
    configTime: identity.time,
    extensions: normalizeExtensions(options.extensions),
    generation: options.generation,
    projectRootDir: normalizeAbsolutePath(options.projectRootDir),
    virtualFilesIdentity: createVirtualFilesIdentity(options.virtualFiles),
    vueSemanticIdentity: options.vueSemanticIdentity?.id,
  });
}
