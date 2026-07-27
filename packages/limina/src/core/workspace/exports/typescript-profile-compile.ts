import { getCheckerAdapter, normalizeExtensions } from '#checkers';
import type {
  TypeScriptProfileFallbackReason,
  TypeScriptResolutionSemanticsAdapter,
  TypeScriptWorkspaceExportProfileKey,
} from './profile-types';
import type { WorkspaceExportsResolutionProfile } from './types';
import {
  type CompiledSemantics,
  compileNativeTypeScriptKey,
} from './typescript-profile';

export interface CompiledTypeScriptProfile {
  readonly fallbackReason: TypeScriptProfileFallbackReason | null;
  readonly id: string;
  readonly key: TypeScriptWorkspaceExportProfileKey;
}

function getEffectiveCheckerPresets(
  profile: WorkspaceExportsResolutionProfile,
): readonly string[] {
  return profile.checkerPresets.length > 0 ? profile.checkerPresets : ['tsc'];
}

function hasTypeScriptCheckerAdapter(
  profile: WorkspaceExportsResolutionProfile,
): boolean {
  return getEffectiveCheckerPresets(profile).some((preset) =>
    Boolean(getCheckerAdapter(preset)),
  );
}

function createSingletonTypeScriptKey(
  originalIndex: number,
  originalConfigPath: string,
): TypeScriptWorkspaceExportProfileKey {
  return ['singleton-fallback-v1', originalIndex, originalConfigPath];
}

function createCompiledResult(
  key: TypeScriptWorkspaceExportProfileKey,
  fallbackReason: TypeScriptProfileFallbackReason | null,
): CompiledTypeScriptProfile {
  return { fallbackReason, id: JSON.stringify(key), key };
}

function createSingletonFallback(options: {
  fallbackReason: TypeScriptProfileFallbackReason;
  originalIndex: number;
  profile: WorkspaceExportsResolutionProfile;
}): CompiledTypeScriptProfile {
  return createCompiledResult(
    createSingletonTypeScriptKey(
      options.originalIndex,
      options.profile.configPath,
    ),
    options.fallbackReason,
  );
}

function compileNativeProfile(options: {
  compiledSemantics: CompiledSemantics;
  originalIndex: number;
  profile: WorkspaceExportsResolutionProfile;
}): CompiledTypeScriptProfile {
  const compiledKey = compileNativeTypeScriptKey(options);

  if ('fallbackReason' in compiledKey) {
    return createSingletonFallback({
      fallbackReason: compiledKey.fallbackReason,
      originalIndex: options.originalIndex,
      profile: options.profile,
    });
  }

  return createCompiledResult(compiledKey.key, null);
}

function compileAdaptedProfile(options: {
  adapter: TypeScriptResolutionSemanticsAdapter;
  originalIndex: number;
  profile: WorkspaceExportsResolutionProfile;
}): CompiledTypeScriptProfile {
  const semantics = options.adapter.compile(options.profile.options);

  if ('fallbackReason' in semantics) {
    return createSingletonFallback({
      fallbackReason: semantics.fallbackReason,
      originalIndex: options.originalIndex,
      profile: options.profile,
    });
  }

  return compileNativeProfile({
    compiledSemantics: semantics,
    originalIndex: options.originalIndex,
    profile: options.profile,
  });
}

export function compileTypeScriptProfile(options: {
  adapter: TypeScriptResolutionSemanticsAdapter;
  originalIndex: number;
  profile: WorkspaceExportsResolutionProfile;
}): CompiledTypeScriptProfile {
  if (hasTypeScriptCheckerAdapter(options.profile)) {
    return compileAdaptedProfile(options);
  }

  return createCompiledResult(
    ['fallback-only-v1', normalizeExtensions(options.profile.extensions)],
    null,
  );
}
