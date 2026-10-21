import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { existsSync, realpathSync } from 'node:fs';
import type { SourceConfigCoverageIndex } from '../../domain/analysis/native-coverage';
import { FileOwnerLookup } from '../build-graph/file-owner-lookup';
import { nativeFingerprint } from './native-file-identity';

function getRealPath(fileName: string): string {
  return normalizeAbsolutePath(
    existsSync(fileName) ? realpathSync.native(fileName) : fileName,
  );
}

function getPathIdentities(fileName: string): string[] {
  return [...new Set([normalizeAbsolutePath(fileName), getRealPath(fileName)])];
}

export interface WorkspaceSourceBoundary {
  readonly sourceConfigCoverage?: SourceConfigCoverageIndex;
  readonly identity: string;
  readonly governance?: {
    membership: FileOwnerLookup;
    isWorkspaceFile(fileName: string): boolean;
  };
  has(fileName: string): boolean;
}

export function createWorkspaceSourceBoundary(
  fileNames: Iterable<string>,
  governance?: WorkspaceSourceBoundary['governance'],
  sourceConfigCoverage?: SourceConfigCoverageIndex,
): WorkspaceSourceBoundary {
  const pathIdentitiesByFileName = new Map<string, readonly string[]>();
  const getCachedPathIdentities = (fileName: string): readonly string[] => {
    const normalized = normalizeAbsolutePath(fileName);
    const cached = pathIdentitiesByFileName.get(normalized);
    if (cached !== undefined) return cached;
    const resolved = getPathIdentities(normalized);
    pathIdentitiesByFileName.set(normalized, resolved);
    return resolved;
  };
  const identities = new Set<string>();
  for (const fileName of fileNames) {
    for (const identity of getCachedPathIdentities(fileName)) {
      identities.add(identity);
    }
  }
  const sortedIdentities = [...identities].sort(compareCodeUnits);
  return {
    sourceConfigCoverage,
    governance,
    identity: JSON.stringify({
      adapterVersion: 'workspace-source-boundary-v2',
      coverage: coverageIdentity(sourceConfigCoverage),
      membership: sortedIdentities.map((file) => [
        file,
        governance?.membership.get(file) ?? [],
      ]),
      fileNames: sortedIdentities,
    }),
    has(fileName: string): boolean {
      return getCachedPathIdentities(fileName).some((identity) =>
        identities.has(identity),
      );
    },
  };
}

function coverageIdentity(index: SourceConfigCoverageIndex | undefined) {
  return index === undefined ? null : nativeFingerprint(index);
}

export function createWorkspaceSourceBoundaryFromProjects(
  projects: Iterable<{
    fileNames: readonly string[];
    ownedFileNames?: readonly string[];
    configPath?: string;
    packageRootDir?: string;
  }>,
  governance?: WorkspaceSourceBoundary['governance'],
  sourceConfigCoverage?: SourceConfigCoverageIndex,
): WorkspaceSourceBoundary {
  const inputs = [...projects];
  const membership =
    governance === undefined
      ? new FileOwnerLookup(
          inputs.flatMap((project) =>
            project.configPath === undefined
              ? []
              : [
                  {
                    configPath: project.configPath,
                    fileNames: project.ownedFileNames ?? project.fileNames,
                  },
                ],
          ),
        )
      : governance.membership;
  const roots = inputs.flatMap((project) =>
    project.packageRootDir ? [getRealPath(project.packageRootDir)] : [],
  );
  return createWorkspaceSourceBoundary(
    inputs.flatMap((project) => project.ownedFileNames ?? project.fileNames),
    governance ?? {
      membership,
      isWorkspaceFile: (file) => {
        const real = getRealPath(file);
        return (
          !real.includes('/node_modules/') &&
          roots.some((root) => real.startsWith(`${root}/`))
        );
      },
    },
    sourceConfigCoverage,
  );
}
