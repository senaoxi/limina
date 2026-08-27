import type { CheckerPreset } from '#config/runner';
import { getCheckerAdapter } from './checker/registry';

export {
  createAstroMaterializedIdentity,
  createAstroSemanticProject,
  materializeAstroSemanticProject,
} from './checker/astro-semantic-identity';
export { resolveAstroSemanticToolchain } from './checker/astro-semantic-toolchain';
export type {
  AstroConfigClosureEntry,
  AstroLanguage,
  AstroLanguagePlugin,
  AstroMaterializedProject,
  AstroSemanticProject,
  AstroSemanticProjectSnapshot,
  AstroSemanticProjectSnapshotInput,
  AstroSemanticSeed,
  AstroSemanticToolchain,
  AstroServiceScript,
  AstroSourceScript,
  AstroUri,
  AstroVirtualCode,
} from './checker/astro-semantic-types';
export { getCheckerExtensions, getResolvedCheckers } from './checker/config';
export {
  CheckerProjectConfigCache,
  parseCheckerProjectConfigForContext,
} from './checker/context';
export {
  createExtraFileExtensions,
  getNativeTypeScriptProjectExtensions,
  getSvelteCheckerExtensions,
  getTypeScriptCheckerExtensions,
  isNativeTypeScriptProjectInput,
  normalizeExtensions,
  resolveExtensionsForChecker,
} from './checker/extensions';
export {
  resolveModuleNameWithCheckers,
  resolveModuleNameWithCheckersDetailed,
  resolveTypeScriptModuleName,
  resolveTypeScriptModuleNameDetailed,
} from './checker/module-resolution';
export {
  collectMissingCheckerPeerDependencies,
  formatMissingCheckerPeerDependencies,
} from './checker/peers';
export {
  getBuildCheckerSupportedExtensions,
  getCheckerAdapter,
  getCheckerBuildEngine,
  getCheckerCapabilityFamily,
  isBuildCapablePreset,
  isCheckerCacheReusable,
} from './checker/registry';
export type {
  CheckerAdapter,
  CheckerBuildEngine,
  CheckerCapabilityFamily,
  CheckerCommandTarget,
  CheckerCommandTargetOptions,
  CheckerDependencies,
  CheckerDependencyCategory,
  CheckerDependencyRequirement,
  CheckerModuleResolutionMetricsRecorder,
  CheckerModuleResolveOptions,
  CheckerPackageResolver,
  CheckerProjectConfigParseOptions,
  CheckerProjectParseContext,
  MissingCheckerPeerDependency,
  ParsedCheckerProjectConfig,
  ResolvedCheckerModuleName,
  VueLanguageCore,
} from './checker/types';
export {
  isSupportedVueSemanticVersionTuple,
  resolveVueSemanticAdapter,
  resolveVueSourceProfile,
} from './checker/vue-semantic-identity';
export type {
  VolarLanguage,
  VolarSourceScript,
  VueLanguageServiceHost,
  VueProjectSemanticIdentity,
  VueResolvedModule,
  VueSemanticAdapter,
  VueSemanticAdapterFamily,
  VueSemanticToolchain,
  VueSemanticVersionTuple,
  VueSourceProfile,
} from './checker/vue-semantic-types';

export function resolveCheckerProjectExtensions(options: {
  configPath: string;
  preset: CheckerPreset;
  projectRootDir: string;
  virtualFiles?: ReadonlyMap<string, string>;
}): string[] {
  const adapter = getCheckerAdapter(options.preset);
  if (adapter === null) {
    throw new Error(`Checker preset "${options.preset}" is not supported.`);
  }
  return adapter.extensions({
    configPath: options.configPath,
    projectRootDir: options.projectRootDir,
    virtualFiles: options.virtualFiles,
  });
}
