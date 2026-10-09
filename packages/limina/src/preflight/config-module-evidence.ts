import type { ResolvedLiminaConfig } from '#config/runner';
import {
  type ConfigModuleEvidence,
  configModuleMetadata,
  getConfigModuleEvidence,
} from '../config/input-observation';
import type { ConfigModuleFile } from '../core/analysis-cache/contracts';

function unobservedEvidence(): ConfigModuleEvidence {
  return {
    loader: 'unobserved',
    files: new Map(),
    dependencies: new Map(),
    bytes: new Map(),
    loadedSources: new Map(),
    bindings: new Map(),
    resolutions: new Map(),
    requestBindings: new Map(),
    unknown: new Set(['configuration-loader-unobserved']),
    warned: new Set(),
    metrics: {},
  };
}
function addFile(
  evidence: ConfigModuleEvidence,
  file: Omit<ConfigModuleFile, 'contentHash'>,
  text: string | null,
): void {
  if (hasCapturedPath(evidence, file.path)) return;
  evidence.files.set(file.path, file);
  evidence.bindings.set(file.path, file.binding);
  if (text !== null) evidence.bytes.set(file.path, Buffer.from(text));
}
function hasCapturedPath(
  evidence: ConfigModuleEvidence,
  path: string,
): boolean {
  return (
    evidence.files.has(path) ||
    evidence.files.values().some((file) => file.logicalPath === path)
  );
}
export function configModuleEvidence(
  config: ResolvedLiminaConfig,
  inputs: ReadonlyMap<string, string | null>,
  bindings: ReadonlyMap<string, string>,
): ConfigModuleEvidence {
  const evidence = getConfigModuleEvidence(config) ?? unobservedEvidence();
  for (const [file, text] of inputs) {
    const record = {
      path: file,
      role: configModuleRole(file, config.configPath),
      binding: bindings.get(file)!,
      metadata: configModuleMetadata(file),
      format: null,
    };
    addFile(evidence, record, text);
  }
  return evidence;
}

function configModuleRole(
  file: string,
  configPath: string,
): ConfigModuleFile['role'] {
  return file === configPath ? 'module' : 'anchor';
}
