import type { VueProjectSemanticIdentity } from '#checkers';
import { isPlainRecord } from '#utils/values';
import { readFileSync } from 'node:fs';
import { type DataNode, encodeData } from './data-codec';
import { analysisHash } from './identity';

export const VUE_ANALYSIS_ADAPTER = 'vue-3.2.4-v2';

function hasPlugins(plugins: unknown): boolean {
  return plugins !== undefined && hasPluginEntries(plugins);
}
function hasPluginEntries(plugins: unknown): boolean {
  return !Array.isArray(plugins) || plugins.length > 0;
}
function hasConfiguredPlugins(identity: VueProjectSemanticIdentity): boolean {
  return identity.configClosure.some(({ filePath }) => {
    const parsed = identity.toolchain.tsModule.parseConfigFileTextToJson(
      filePath,
      readFileSync(filePath, 'utf8'),
    );
    return parsed.error !== undefined || hasPluginsFromConfig(parsed.config);
  });
}
function hasPluginsFromConfig(config: {
  vueCompilerOptions?: { plugins?: unknown };
}): boolean {
  return hasPlugins(config.vueCompilerOptions?.plugins);
}
function hasNoRuntimePlugins(options: Record<string, unknown>): boolean {
  const plugins = options.plugins;
  return Array.isArray(plugins) && plugins.length === 0;
}
export function isVueAnalysisSupported(
  identity: VueProjectSemanticIdentity | undefined,
): boolean {
  if (identity === undefined) return false;
  const versions = identity.toolchain.versions;
  if (!isPlainRecord(identity.vueOptions)) return false;
  return [
    identity.toolchain.adapter.kind !== 'unsupported',
    versions.typeScript === '6.0.3',
    versions.vueTsc === '3.2.4',
    versions.languageCore === '3.2.4',
    versions.volarTypeScript === '2.4.27',
    identity.virtualFiles.size === 0,
    hasNoRuntimePlugins(identity.vueOptions),
    !hasConfiguredPlugins(identity),
    isSerializableIdentity(identity),
  ].every(Boolean);
}

function isSerializableIdentity(identity: VueProjectSemanticIdentity): boolean {
  try {
    vueDataIdentity(identity);
    return true;
  } catch {
    return false;
  }
}

export function vueDataIdentity(
  identity: VueProjectSemanticIdentity,
): DataNode {
  // Config ASTs are runtime objects; their source closure is separately observed.
  const options = { ...identity.options };
  delete options.configFile;
  return encodeData({
    adapter: VUE_ANALYSIS_ADAPTER,
    configPath: identity.configPath,
    projectRootDir: identity.projectRootDir,
    configClosure: identity.configClosure,
    options,
    vueOptions: identity.vueOptions,
    fileNames: identity.fileNames,
    projectReferences: identity.projectReferences,
    extensions: identity.extensions,
    profiles: identity.profilesByFileName,
    overlayFingerprint: identity.overlayFingerprint,
    toolchain: [
      identity.toolchain.adapter,
      identity.toolchain.paths,
      identity.toolchain.versions,
    ],
  });
}

export function vueContextId(identity: VueProjectSemanticIdentity): string {
  return analysisHash(vueDataIdentity(identity));
}
