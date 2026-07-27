import type {
  ImporterInfo,
  PackageOwner,
  WorkspacePackage,
} from '#core/workspace/actions';
import type {
  WorkspaceIndexMetricsRecorder,
  WorkspaceRegionPathIndex,
} from '../validated-context';

export interface WorkspaceLookupIndexOptions {
  importers: ImporterInfo[];
  owners: PackageOwner[];
  packages: WorkspacePackage[];
  rootDir: string;
  pathIndex: WorkspaceRegionPathIndex;
  metrics?: WorkspaceIndexMetricsRecorder;
}

export interface IndexedImporter {
  importer: ImporterInfo;
  originalOrdinal: number;
}

export interface PackageLookupBounds {
  activatedPackageRoot: string | null;
  allowNodeModulesPackage: boolean;
}

export interface NearestPackageLookupOptions {
  requireNamedPackageOrNodeModulesPackage: boolean;
}
