import path from 'pathe';
import { currentProfile } from '../../application/analysis/observability';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import type { PackageScopeSnapshot } from './contracts';
import type { AnalysisInputs } from './inputs';

export function capturePackageScopes(
  inputs: AnalysisInputs,
  regions: WorkspaceRegionPathIndex,
  sources: Iterable<string>,
  solutions: Iterable<string>,
): PackageScopeSnapshot {
  const observer = currentProfile();
  const manifests: PackageScopeSnapshot['manifests'] = {};
  for (const manifest of regions.packageScopes.manifests) {
    const observation = inputs.observe(manifest.path, 'manifest');
    inputs.consume([observation]);
    manifests[manifest.path] = {
      directory: manifest.directory,
      role: manifest.role,
      version: observation.expectedVersion,
    };
    observer?.metric(
      'cache.package-scope.manifests-observed',
      observer.currentScope,
      'items',
      1,
    );
  }
  const configs: PackageScopeSnapshot['configs'] = {};
  for (const [role, paths] of [
    ['source', sources],
    ['solution', solutions],
  ] as const)
    for (const file of paths) {
      const scope = regions.packageScopeForFile(file);
      if (scope !== undefined) configs[file] = { scope, role };
      if (observer === undefined) continue;
      const project = ['project', observer.project(file)] as const;
      observer.metric(
        'cache.package-scope.configs-scanned',
        project,
        'items',
        1,
      );
      if (scope !== undefined)
        observer.metric(
          'cache.package-scope.configs-bound',
          project,
          'items',
          1,
        );
    }
  return { manifests, configs };
}

function parents(snapshot: PackageScopeSnapshot): Map<string, string> {
  return new Map(
    Object.entries(snapshot.manifests).map(([file, manifest]) => [
      manifest.directory,
      file,
    ]),
  );
}

type ScopeChange =
  | 'package-scope-manifest-changed'
  | 'package-scope-containing-boundary-changed';

/**
An inserted or removed boundary changes only the immediate containing scope.
*/
function addParent(
  affected: Map<string, ScopeChange>,
  directories: Map<string, string>,
  child: string,
): void {
  let directory = path.dirname(child);
  while (true) {
    const manifest = directories.get(directory);
    if (manifest !== undefined) {
      if (!affected.has(manifest))
        affected.set(manifest, 'package-scope-containing-boundary-changed');
      return;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

export function invalidatedPackageConfigs(
  previous: PackageScopeSnapshot,
  current: PackageScopeSnapshot,
): Set<string> {
  const observer = currentProfile();
  const affected = new Map<string, ScopeChange>();
  const before = parents(previous);
  const after = parents(current);
  const files = new Set([
    ...Object.keys(previous.manifests),
    ...Object.keys(current.manifests),
  ]);
  for (const file of files) {
    const old = previous.manifests[file];
    const next = current.manifests[file];
    if (old?.version !== next?.version || old?.role !== next?.role)
      affected.set(file, 'package-scope-manifest-changed');
    if (old?.directory === next?.directory && old?.role === next?.role)
      continue;
    if (old !== undefined) addParent(affected, after, old.directory);
    if (next !== undefined) addParent(affected, before, next.directory);
  }
  const invalid = new Set<string>();
  const configs = new Set([
    ...Object.keys(previous.configs),
    ...Object.keys(current.configs),
  ]);
  for (const file of configs) {
    const old = previous.configs[file];
    const next = current.configs[file];
    const reason =
      old?.scope !== next?.scope || old?.role !== next?.role
        ? 'package-scope-binding-changed'
        : next === undefined
          ? undefined
          : affected.get(next.scope);
    if (reason === undefined) continue;
    invalid.add(file);
    if (observer === undefined) continue;
    const scope =
      next === undefined
        ? observer.currentScope
        : (['project', observer.project(file)] as const);
    observer.metric(
      'cache.package-scope.configs-invalidated',
      scope,
      'items',
      1,
    );
    observer.decision(
      'package-scope',
      { stage: 'admission', outcome: 'rejected', causes: [{ code: reason }] },
      observer.path(file),
    );
  }
  return invalid;
}
