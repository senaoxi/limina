import type { ResolvedLiminaConfig } from '#config/runner';
import type { NamedWorkspacePackage } from '#core/workspace/actions';
import path from 'pathe';
import type { ReleaseConsistencyState } from '../consistency/types';
import { compareWorkspacePackageRelease } from './comparison';
import { resolveWorkspaceContentHashPolicy } from './policy';
import { resolveWorkspaceRegistryBaseline } from './registry-baseline';

export async function verifyWorkspacePackagePublished(options: {
  config: ResolvedLiminaConfig;
  importerName: string;
  state: ReleaseConsistencyState;
  workspacePackage: NamedWorkspacePackage;
}): Promise<void> {
  const dependencyName = options.workspacePackage.name;
  const sourceManifestPath = path.join(
    options.workspacePackage.directory,
    'package.json',
  );
  const policy = resolveWorkspaceContentHashPolicy({
    args: { dependencyName, importerName: options.importerName },
    config: options.config,
    dependencyName,
    importerName: options.importerName,
    sourceManifestPath,
    state: options.state,
  });
  if (policy === null) return;
  const baseline = await resolveWorkspaceRegistryBaseline({
    baselineTag: policy.baselineTag,
    dependencyName,
    importerName: options.importerName,
    sourceManifestPath,
    state: options.state,
  });
  if (baseline === null) return;
  await compareWorkspacePackageRelease({
    baseline,
    config: options.config,
    dependencyName,
    ignoreRules: policy.ignoreRules,
    importerName: options.importerName,
    sourceManifestPath,
    state: options.state,
    workspacePackage: options.workspacePackage,
  });
}
