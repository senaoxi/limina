import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { existsSync, realpathSync } from 'node:fs';

function getRealPath(fileName: string): string {
  if (!existsSync(fileName)) return normalizeAbsolutePath(fileName);
  return normalizeAbsolutePath(realpathSync.native(fileName));
}

function getPathIdentities(fileName: string): string[] {
  return [...new Set([normalizeAbsolutePath(fileName), getRealPath(fileName)])];
}

export interface WorkspaceSourceBoundary {
  readonly identity: string;
  has(fileName: string): boolean;
}

export function createWorkspaceSourceBoundary(
  fileNames: Iterable<string>,
): WorkspaceSourceBoundary {
  const identities = new Set<string>();
  for (const fileName of fileNames) {
    for (const identity of getPathIdentities(fileName)) {
      identities.add(identity);
    }
  }
  const sortedIdentities = [...identities].sort(compareCodeUnits);
  return {
    identity: JSON.stringify({
      adapterVersion: 'workspace-source-boundary-v1',
      fileNames: sortedIdentities,
    }),
    has(fileName: string): boolean {
      return getPathIdentities(fileName).some((identity) =>
        identities.has(identity),
      );
    },
  };
}

export function createWorkspaceSourceBoundaryFromProjects(
  projects: Iterable<{ fileNames: readonly string[] }>,
): WorkspaceSourceBoundary {
  return createWorkspaceSourceBoundary(
    [...projects].flatMap((project) => project.fileNames),
  );
}
