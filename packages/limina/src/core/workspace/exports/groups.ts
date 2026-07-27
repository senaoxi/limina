import {
  createOxcResolverProfileIdentity,
  type OxcResolverProfileIdentity,
} from '#core/import-analysis/runner';
import { createTypeScriptResolutionSemanticsAdapter } from '../typescript-resolution-semantics';
import type {
  CompiledWorkspaceExportResolutionProfile,
  OxcResolverPlan,
  TypeScriptResolutionSemanticsAdapter,
  TypeScriptResolverPlan,
  TypeScriptWorkspaceExportProfileKey,
  WorkspaceExportResolutionGroups,
} from './profile-types';
import type { WorkspaceExportsResolutionProfile } from './types';
import { compileTypeScriptProfile } from './typescript-profile-compile';

interface ResolutionGroupState {
  byConfigPath: Map<string, CompiledWorkspaceExportResolutionProfile>;
  compiledOriginals: CompiledWorkspaceExportResolutionProfile[];
  oxcGroups: Map<string, OxcResolverPlan>;
  typescriptGroups: Map<string, TypeScriptResolverPlan>;
}

function addTypeScriptPlanMember(options: {
  groups: Map<string, TypeScriptResolverPlan>;
  id: string;
  key: TypeScriptWorkspaceExportProfileKey;
  originalIndex: number;
}): void {
  const existing = options.groups.get(options.id);
  options.groups.set(
    options.id,
    existing === undefined
      ? {
          id: options.id,
          key: options.key,
          memberIndexes: [options.originalIndex],
          representativeIndex: options.originalIndex,
        }
      : {
          ...existing,
          memberIndexes: [...existing.memberIndexes, options.originalIndex],
        },
  );
}

function addOxcPlanMember(options: {
  groups: Map<string, OxcResolverPlan>;
  identity: OxcResolverProfileIdentity;
  originalIndex: number;
}): void {
  const existing = options.groups.get(options.identity.id);
  options.groups.set(
    options.identity.id,
    existing === undefined
      ? {
          ...options.identity,
          memberIndexes: [options.originalIndex],
          representativeIndex: options.originalIndex,
        }
      : {
          ...existing,
          memberIndexes: [...existing.memberIndexes, options.originalIndex],
        },
  );
}

function createCompiledOriginal(options: {
  adapter: TypeScriptResolutionSemanticsAdapter;
  originalIndex: number;
  profile: WorkspaceExportsResolutionProfile;
}): {
  compiled: CompiledWorkspaceExportResolutionProfile;
  oxcIdentity: OxcResolverProfileIdentity;
  typeScriptKey: TypeScriptWorkspaceExportProfileKey;
} {
  const typeScript = compileTypeScriptProfile(options);
  const oxcIdentity = createOxcResolverProfileIdentity({
    compilerOptions: options.profile.options,
    context: {
      checkerPresets: options.profile.checkerPresets,
      configPath: options.profile.configPath,
      extensions: options.profile.extensions,
      resolverConfigPath: options.profile.resolverConfigPath,
    },
  });
  return {
    compiled: {
      original: options.profile,
      originalConfigPath: options.profile.configPath,
      originalIndex: options.originalIndex,
      oxcProfileId: oxcIdentity.id,
      typescriptFallbackReason: typeScript.fallbackReason,
      typescriptProfileId: typeScript.id,
    },
    oxcIdentity,
    typeScriptKey: typeScript.key,
  };
}

function addOriginalToGroups(options: {
  adapter: TypeScriptResolutionSemanticsAdapter;
  originalIndex: number;
  profile: WorkspaceExportsResolutionProfile;
  state: ResolutionGroupState;
}): void {
  const result = createCompiledOriginal(options);
  options.state.compiledOriginals.push(result.compiled);
  options.state.byConfigPath.set(options.profile.configPath, result.compiled);
  addTypeScriptPlanMember({
    groups: options.state.typescriptGroups,
    id: result.compiled.typescriptProfileId,
    key: result.typeScriptKey,
    originalIndex: options.originalIndex,
  });
  addOxcPlanMember({
    groups: options.state.oxcGroups,
    identity: result.oxcIdentity,
    originalIndex: options.originalIndex,
  });
}

function createResolutionGroupState(): ResolutionGroupState {
  return {
    byConfigPath: new Map(),
    compiledOriginals: [],
    oxcGroups: new Map(),
    typescriptGroups: new Map(),
  };
}

function resolveTypeScriptAdapter(
  adapter: TypeScriptResolutionSemanticsAdapter | undefined,
): TypeScriptResolutionSemanticsAdapter {
  return adapter === undefined
    ? createTypeScriptResolutionSemanticsAdapter()
    : adapter;
}

export function compileWorkspaceExportResolutionGroups(
  originals: readonly WorkspaceExportsResolutionProfile[],
  options: {
    readonly typeScriptAdapter?: TypeScriptResolutionSemanticsAdapter;
  } = {},
): WorkspaceExportResolutionGroups {
  const adapter = resolveTypeScriptAdapter(options.typeScriptAdapter);
  const state = createResolutionGroupState();

  for (const [originalIndex, profile] of originals.entries()) {
    addOriginalToGroups({ adapter, originalIndex, profile, state });
  }

  return {
    ...state,
    originals,
  };
}
