import type { VueProjectSemanticIdentity } from '#checkers';
import { isPlainRecord } from '#utils/values';
import { readFileSync } from 'node:fs';
import { vueCompilerPathPolicy } from '../../checker/vue-semantic-identity';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import { type DataNode, encodeData } from './data-codec';
import { analysisHash } from './identity';

export const VUE_ANALYSIS_ADAPTER = 'vue-3.2.4-v16-resolution-members';

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

function vueSemanticInputs(identity: VueProjectSemanticIdentity) {
  // Config ASTs are runtime objects; their source closure is separately observed.
  const options = { ...identity.options };
  delete options.configFile;
  return {
    adapter: VUE_ANALYSIS_ADAPTER,
    hostContract: vueCompilerPathPolicy(identity).identity,
    declarationLoading:
      identity.declarationLoading === undefined
        ? undefined
        : nativeFingerprint(identity.declarationLoading),
    configPath: identity.configPath,
    outputProjection: identity.outputProjection,
    projectRootDir: identity.projectRootDir,
    configClosure: identity.configClosure.map(({ filePath }) => filePath),
    options,
    vueOptions: identity.vueOptions,
    projectReferences: identity.projectReferences,
    extensions: identity.extensions,
    overlayFingerprint: identity.overlayFingerprint,
    toolchain: [
      identity.toolchain.adapter,
      identity.toolchain.paths,
      identity.toolchain.versions,
    ],
  };
}

export function vueDataIdentity(
  identity: VueProjectSemanticIdentity,
): DataNode {
  return encodeData({
    ...vueSemanticInputs(identity),
    fileNames: identity.fileNames,
    profiles: identity.profilesByFileName,
  });
}

export function vueModuleContextId(
  identity: VueProjectSemanticIdentity,
): string {
  // The qualified built-in Vue plugin has no extra service scripts. Volar
  // generates the selected candidate from its own physical source snapshot.
  return analysisHash(vueModuleProjection(vueDataIdentity(identity)));
}

function vueModuleProjection(data: DataNode): DataNode | undefined {
  if (!Array.isArray(data) || data[0] !== 'object' || !Array.isArray(data[1]))
    return undefined;
  const programFields = new Set([
    'declarationLoading',
    'fileNames',
    'profiles',
  ]);
  return [
    'object',
    data[1].filter(
      (entry) => !Array.isArray(entry) || !programFields.has(entry[0]),
    ),
  ];
}

export function hasVueModuleContextId(data: DataNode, id: string): boolean {
  const projection = vueModuleProjection(data);
  return projection !== undefined && analysisHash(projection) === id;
}

export function vueContextId(identity: VueProjectSemanticIdentity): string {
  return analysisHash(vueDataIdentity(identity));
}
