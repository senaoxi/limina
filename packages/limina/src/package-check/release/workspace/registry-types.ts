import type {
  RegistryTarballIntegrityResult,
  ReleaseConsistencyState,
} from '../consistency/types';
import type { EffectiveRegistryAuthority } from '../registry/authority';

export interface WorkspaceRegistryContext {
  baselineTag: string;
  dependencyName: string;
  importerName: string;
  sourceManifestPath: string;
  state: ReleaseConsistencyState;
}

export interface WorkspaceRegistryBaseline {
  authority: EffectiveRegistryAuthority;
  baselineTag: string;
  baselineVersion: string;
  integrityResult: Extract<RegistryTarballIntegrityResult, { kind: 'found' }>;
  registryUrl: string;
  tarballUrl: string;
}
