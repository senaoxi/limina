import type {
  RegistryTarballIntegrityResult,
  ReleaseConsistencyState,
} from '../consistency/types';

export interface WorkspaceRegistryContext {
  baselineTag: string;
  dependencyName: string;
  importerName: string;
  sourceManifestPath: string;
  state: ReleaseConsistencyState;
}

export interface WorkspaceRegistryBaseline {
  baselineTag: string;
  baselineVersion: string;
  integrityResult: Extract<RegistryTarballIntegrityResult, { kind: 'found' }>;
  registryUrl: string;
  tarballUrl: string;
}
