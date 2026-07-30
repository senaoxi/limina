import type { CheckerPreset } from '#config/runner';
import { getCheckerAdapter } from './checker/registry';

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
} from './checker/registry';
export type {
  CheckerAdapter,
  CheckerBuildEngine,
  CheckerCapabilityFamily,
  CheckerCommandTarget,
  CheckerCommandTargetOptions,
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
