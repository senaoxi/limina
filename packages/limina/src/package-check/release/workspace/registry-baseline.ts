import { formatErrorMessage } from '../../../logger';
import { resolveReleaseRegistryMetadataUrl } from '../../release-registry-test-seam';
import {
  addRegistryFinding,
  formatDependencyLocation,
} from '../consistency/findings';
import type {
  RegistryMetadataResult,
  RegistryPackageMetadata,
  RegistryVersionMetadata,
} from '../consistency/types';
import type { ReleaseRegistryFacts } from '../findings/facts';
import {
  fetchRegistryPackageMetadata,
  findRegistryDistTagVersion,
  findRegistryVersionMetadata,
  formatRegistryMetadataFailure,
  getRegistryTarballUrl,
} from '../registry';
import { resolveWorkspaceRegistryIntegrity } from './registry-integrity';
import type {
  WorkspaceRegistryBaseline,
  WorkspaceRegistryContext,
} from './registry-types';

const METADATA_FAILURE_KINDS = {
  'body-read': 'metadata-body-read',
  'http-status': 'metadata-http-status',
  'invalid-json': 'metadata-invalid-json',
  'invalid-metadata': 'metadata-invalid-object',
  request: 'metadata-request',
  timeout: 'metadata-timeout',
} as const satisfies Record<
  Extract<RegistryMetadataResult, { kind: 'failure' }>['reason'],
  ReleaseRegistryFacts['kind']
>;

function addMetadataFailure(options: {
  context: WorkspaceRegistryContext;
  result: Extract<RegistryMetadataResult, { kind: 'failure' }>;
}): void {
  addRegistryFinding(options.context.state, {
    facts: {
      dependencyName: options.context.dependencyName,
      errorMessage:
        options.result.cause === undefined
          ? undefined
          : formatErrorMessage(options.result.cause),
      importerName: options.context.importerName,
      kind: METADATA_FAILURE_KINDS[options.result.reason],
      registryUrl: options.result.url,
      statusCode: options.result.statusCode,
      statusText: options.result.statusText,
      timeoutMs: options.result.timeoutMs,
    },
    filePath: options.context.sourceManifestPath,
    message: `${formatDependencyLocation(options.context)}: ${formatRegistryMetadataFailure(options.context.dependencyName, options.result)}`,
    packageManifestPath: options.context.sourceManifestPath,
    packageName: options.context.dependencyName,
  });
}

function addMissingPackage(options: {
  context: WorkspaceRegistryContext;
  result: Extract<RegistryMetadataResult, { kind: 'missing' }>;
}): void {
  options.context.state.unpublishedPackageNames.add(
    options.context.dependencyName,
  );
  addRegistryFinding(options.context.state, {
    facts: {
      dependencyName: options.context.dependencyName,
      importerName: options.context.importerName,
      kind: 'package-not-found',
      registryUrl: options.result.url,
      statusCode: options.result.statusCode,
    },
    filePath: options.context.sourceManifestPath,
    message: `${formatDependencyLocation(options.context)}: ${options.context.dependencyName} is not published to the npm registry`,
    packageManifestPath: options.context.sourceManifestPath,
    packageName: options.context.dependencyName,
  });
}

function resolveMetadataResult(options: {
  context: WorkspaceRegistryContext;
  result: RegistryMetadataResult;
}): RegistryPackageMetadata | null {
  if (options.result.kind === 'failure') {
    addMetadataFailure({ context: options.context, result: options.result });
    return null;
  }
  if (options.result.kind === 'missing') {
    addMissingPackage({ context: options.context, result: options.result });
    return null;
  }
  return options.result.metadata;
}

function addMissingDistTag(options: {
  context: WorkspaceRegistryContext;
  registryUrl: string;
}): void {
  addRegistryFinding(options.context.state, {
    facts: {
      dependencyName: options.context.dependencyName,
      importerName: options.context.importerName,
      kind: 'dist-tag-missing',
      registryUrl: options.registryUrl,
      requestedDistTag: options.context.baselineTag,
    },
    filePath: options.context.sourceManifestPath,
    message: `${formatDependencyLocation(options.context)}: ${options.context.dependencyName} registry metadata has no "${options.context.baselineTag}" dist-tag`,
    packageManifestPath: options.context.sourceManifestPath,
    packageName: options.context.dependencyName,
  });
}

function resolveBaselineVersion(options: {
  context: WorkspaceRegistryContext;
  metadata: RegistryPackageMetadata;
  registryUrl: string;
}): string | null {
  const version = findRegistryDistTagVersion(
    options.metadata,
    options.context.baselineTag,
  );
  if (version !== null) return version;
  addMissingDistTag(options);
  return null;
}

function addMissingVersion(options: {
  baselineVersion: string;
  context: WorkspaceRegistryContext;
  registryUrl: string;
}): void {
  addRegistryFinding(options.context.state, {
    facts: {
      dependencyName: options.context.dependencyName,
      importerName: options.context.importerName,
      kind: 'version-missing',
      registryUrl: options.registryUrl,
      requestedDistTag: options.context.baselineTag,
      requestedVersion: options.baselineVersion,
    },
    filePath: options.context.sourceManifestPath,
    message: `${formatDependencyLocation(options.context)}: ${options.context.dependencyName}@${options.baselineVersion} is not published to the npm registry`,
    packageManifestPath: options.context.sourceManifestPath,
    packageName: options.context.dependencyName,
  });
}

function resolveVersionMetadata(options: {
  baselineVersion: string;
  context: WorkspaceRegistryContext;
  metadata: RegistryPackageMetadata;
  registryUrl: string;
}): RegistryVersionMetadata | null {
  const versionMetadata = findRegistryVersionMetadata(
    options.metadata,
    options.baselineVersion,
  );
  if (versionMetadata !== null) return versionMetadata;
  addMissingVersion(options);
  return null;
}

function addMissingTarballUrl(options: {
  baselineVersion: string;
  context: WorkspaceRegistryContext;
  registryUrl: string;
}): void {
  addRegistryFinding(options.context.state, {
    facts: {
      dependencyName: options.context.dependencyName,
      importerName: options.context.importerName,
      kind: 'tarball-url-missing',
      registryUrl: options.registryUrl,
      requestedDistTag: options.context.baselineTag,
      requestedVersion: options.baselineVersion,
    },
    filePath: options.context.sourceManifestPath,
    message: `${formatDependencyLocation(options.context)}: ${options.context.dependencyName}@${options.baselineVersion} registry metadata has no dist.tarball`,
    packageManifestPath: options.context.sourceManifestPath,
    packageName: options.context.dependencyName,
  });
}

function resolveTarballUrl(options: {
  baselineVersion: string;
  context: WorkspaceRegistryContext;
  registryUrl: string;
  versionMetadata: RegistryVersionMetadata;
}): string | null {
  const tarballUrl = getRegistryTarballUrl(options.versionMetadata);
  if (tarballUrl !== null) return tarballUrl;
  addMissingTarballUrl(options);
  return null;
}

function createResolvedBaseline(options: {
  baselineVersion: string;
  context: WorkspaceRegistryContext;
  registryUrl: string;
  tarballUrl: string;
  versionMetadata: RegistryVersionMetadata;
}): WorkspaceRegistryBaseline | null {
  const integrityResult = resolveWorkspaceRegistryIntegrity(options);
  if (integrityResult === null) return null;
  return {
    baselineTag: options.context.baselineTag,
    baselineVersion: options.baselineVersion,
    integrityResult,
    registryUrl: options.registryUrl,
    tarballUrl: options.tarballUrl,
  };
}

function resolveBaselineArtifact(options: {
  baselineVersion: string;
  context: WorkspaceRegistryContext;
  metadata: RegistryPackageMetadata;
  registryUrl: string;
}): WorkspaceRegistryBaseline | null {
  const versionMetadata = resolveVersionMetadata(options);
  if (versionMetadata === null) return null;
  const tarballUrl = resolveTarballUrl({ ...options, versionMetadata });
  if (tarballUrl === null) return null;
  return createResolvedBaseline({
    baselineVersion: options.baselineVersion,
    context: options.context,
    registryUrl: options.registryUrl,
    tarballUrl,
    versionMetadata,
  });
}

function resolveBaselineFromMetadata(options: {
  context: WorkspaceRegistryContext;
  metadata: RegistryPackageMetadata;
  registryUrl: string;
}): WorkspaceRegistryBaseline | null {
  const baselineVersion = resolveBaselineVersion(options);
  if (baselineVersion === null) return null;
  return resolveBaselineArtifact({ ...options, baselineVersion });
}

export async function resolveWorkspaceRegistryBaseline(
  context: WorkspaceRegistryContext,
): Promise<WorkspaceRegistryBaseline | null> {
  const registryUrl = resolveReleaseRegistryMetadataUrl(context.dependencyName);
  const result = await fetchRegistryPackageMetadata(
    context.dependencyName,
    context.state,
  );
  const metadata = resolveMetadataResult({ context, result });
  if (metadata === null) return null;
  return resolveBaselineFromMetadata({ context, metadata, registryUrl });
}

export type {
  WorkspaceRegistryBaseline,
  WorkspaceRegistryContext,
} from './registry-types';
