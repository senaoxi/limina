import type { ResolvedLiminaConfig } from '#config/runner';
import type { NamedWorkspacePackage } from '#core/workspace/actions';
import { formatErrorMessage } from '../../../logger';
import { packOutputTarball } from '../../runner';
import type {
  ContentHashIgnoreRule,
  RegistryTarballFailure,
  RegistryTarballIntegrityResult,
  WorkspacePackageOutputComparison,
} from '../consistency/types';
import { RegistryTarballError } from '../consistency/types';
import type { ReleaseRegistryFacts } from '../findings/facts';
import {
  fetchRegistryTarball,
  verifyRegistryTarballIntegrity,
} from '../registry';
import { resolveWorkspacePackageOutputDir } from './config';
import {
  createContentHashDiffs,
  hasContentHashDiffs,
  partitionContentHashDiffs,
  readPackedArtifactContent,
} from './diff';

export async function compareLocalWorkspacePackageOutputToBaseline(options: {
  baselineVersion: string;
  config: ResolvedLiminaConfig;
  dependencyName: string;
  expectedShasum?: string;
  ignoreRules: readonly ContentHashIgnoreRule[];
  integrity: string;
  tarballUrl: string;
  workspacePackage: NamedWorkspacePackage;
}): Promise<WorkspacePackageOutputComparison> {
  const localOutDir = resolveWorkspacePackageOutputDir(
    options.config,
    options.workspacePackage,
  );
  const publishedTarball = await fetchRegistryTarball(options.tarballUrl);
  verifyRegistryTarballIntegrity({
    expectedShasum: options.expectedShasum,
    integrity: options.integrity,
    packageName: options.dependencyName,
    tarball: publishedTarball,
    tarballUrl: options.tarballUrl,
    version: options.baselineVersion,
  });
  const localPackedTarball = await packOutputTarball(localOutDir);
  try {
    const [remoteArtifact, localArtifact] = await Promise.all([
      readPackedArtifactContent(publishedTarball),
      readPackedArtifactContent(localPackedTarball.tarball),
    ]);
    const partition = partitionContentHashDiffs({
      diffs: createContentHashDiffs({ localArtifact, remoteArtifact }),
      ignoreRules: options.ignoreRules,
    });
    return {
      ignoredDiffGroups: partition.ignoredDiffGroups,
      localOutputDirectory: localOutDir,
      localVersion: localArtifact.packageVersion,
      matchesBaseline: !hasContentHashDiffs(partition.releaseRelevantDiffs),
      releaseRelevantDiffs: partition.releaseRelevantDiffs,
    };
  } finally {
    await localPackedTarball.cleanup();
  }
}

function getRegistryTarballFailure(
  error: unknown,
): RegistryTarballFailure | null {
  if (!(error instanceof RegistryTarballError)) return null;
  return error.failure;
}

function getFailureValue<T>(
  failure: RegistryTarballFailure | null,
  selector: (value: RegistryTarballFailure) => T | undefined,
  fallback: T,
): T {
  if (failure === null) return fallback;
  return selector(failure) ?? fallback;
}

function getOptionalFailureValue<T>(
  failure: RegistryTarballFailure | null,
  selector: (value: RegistryTarballFailure) => T | undefined,
): T | undefined {
  if (failure === null) return undefined;
  return selector(failure);
}

export function createRegistryComparisonFailure(options: {
  baselineTag: string;
  baselineVersion: string;
  dependencyName: string;
  error: unknown;
  importerName: string;
  integrityResult: Extract<RegistryTarballIntegrityResult, { kind: 'found' }>;
  registryUrl: string;
  tarballUrl: string;
}): { errorMessage: string; facts: ReleaseRegistryFacts } {
  const failure = getRegistryTarballFailure(options.error);
  const errorMessage = formatErrorMessage(options.error);
  return {
    errorMessage,
    facts: {
      actualIntegrity: getOptionalFailureValue(
        failure,
        (value) => value.actualIntegrity,
      ),
      actualShasum: getOptionalFailureValue(
        failure,
        (value) => value.actualShasum,
      ),
      dependencyName: options.dependencyName,
      errorMessage: getFailureValue(
        failure,
        (value) => value.errorMessage,
        errorMessage,
      ),
      expectedIntegrity: getFailureValue(
        failure,
        (value) => value.expectedIntegrity,
        options.integrityResult.integrity,
      ),
      expectedShasum: getFailureValue(
        failure,
        (value) => value.expectedShasum,
        options.integrityResult.expectedShasum,
      ),
      importerName: options.importerName,
      integritySource: options.integrityResult.source,
      kind: getFailureValue(
        failure,
        (value) => value.kind,
        'comparison-failed',
      ),
      registryIntegrity: options.integrityResult.registryIntegrity,
      registryShasum: options.integrityResult.registryShasum,
      registryUrl: options.registryUrl,
      requestedDistTag: options.baselineTag,
      requestedVersion: options.baselineVersion,
      statusCode: getOptionalFailureValue(failure, (value) => value.statusCode),
      statusText: getOptionalFailureValue(failure, (value) => value.statusText),
      tarballUrl: getFailureValue(
        failure,
        (value) => value.tarballUrl,
        options.tarballUrl,
      ),
      timeoutMs: getOptionalFailureValue(failure, (value) => value.timeoutMs),
    },
  };
}
