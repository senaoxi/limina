import {
  addRegistryFinding,
  formatDependencyLocation,
} from '../consistency/findings';
import type {
  RegistryTarballIntegrityResult,
  RegistryVersionMetadata,
} from '../consistency/types';
import { resolveRegistryTarballIntegrity } from '../registry';
import type { WorkspaceRegistryContext } from './registry-types';

interface IntegrityContext {
  baselineVersion: string;
  context: WorkspaceRegistryContext;
  registryUrl: string;
  tarballUrl: string;
}

function addMissingIntegrity(options: IntegrityContext): void {
  addRegistryFinding(options.context.state, {
    facts: {
      dependencyName: options.context.dependencyName,
      importerName: options.context.importerName,
      kind: 'integrity-missing',
      registryUrl: options.registryUrl,
      requestedDistTag: options.context.baselineTag,
      requestedVersion: options.baselineVersion,
      tarballUrl: options.tarballUrl,
    },
    filePath: options.context.sourceManifestPath,
    message: `${formatDependencyLocation(options.context)}: ${options.context.dependencyName}@${options.baselineVersion} registry metadata has no dist.integrity or dist.shasum`,
    packageManifestPath: options.context.sourceManifestPath,
    packageName: options.context.dependencyName,
  });
}

function addInvalidIntegrity(options: {
  baseline: IntegrityContext;
  result: Extract<RegistryTarballIntegrityResult, { kind: 'invalid' }>;
}): void {
  addRegistryFinding(options.baseline.context.state, {
    facts: {
      dependencyName: options.baseline.context.dependencyName,
      importerName: options.baseline.context.importerName,
      integrityField: options.result.field,
      kind: 'integrity-invalid',
      registryIntegrity: options.result.registryIntegrity,
      registryShasum: options.result.registryShasum,
      registryUrl: options.baseline.registryUrl,
      requestedDistTag: options.baseline.context.baselineTag,
      requestedVersion: options.baseline.baselineVersion,
      tarballUrl: options.baseline.tarballUrl,
    },
    filePath: options.baseline.context.sourceManifestPath,
    message: `${formatDependencyLocation(options.baseline.context)}: ${options.baseline.context.dependencyName}@${options.baseline.baselineVersion} registry metadata has invalid dist.${options.result.field}`,
    packageManifestPath: options.baseline.context.sourceManifestPath,
    packageName: options.baseline.context.dependencyName,
  });
}

function reportIntegrityProblem(options: {
  baseline: IntegrityContext;
  result: Exclude<RegistryTarballIntegrityResult, { kind: 'found' }>;
}): void {
  if (options.result.kind === 'missing') {
    addMissingIntegrity(options.baseline);
    return;
  }
  addInvalidIntegrity({ baseline: options.baseline, result: options.result });
}

export function resolveWorkspaceRegistryIntegrity(options: {
  baselineVersion: string;
  context: WorkspaceRegistryContext;
  registryUrl: string;
  tarballUrl: string;
  versionMetadata: RegistryVersionMetadata;
}): Extract<RegistryTarballIntegrityResult, { kind: 'found' }> | null {
  const result = resolveRegistryTarballIntegrity(options.versionMetadata);
  if (result.kind === 'found') return result;
  reportIntegrityProblem({ baseline: options, result });
  return null;
}
