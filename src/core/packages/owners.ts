import type {
  PackageManifest,
  PackageOwner,
  WorkspacePackage,
} from '#core/workspace/actions';

export interface NearestPackageInfo {
  directory: string;
  manifest: PackageManifest;
  name?: string;
  packageJsonPath: string;
}

export type ResolvedPackageTarget =
  | {
      kind: 'current-owner';
      packageInfo: NearestPackageInfo;
    }
  | {
      kind: 'other-owner';
      packageInfo: NearestPackageInfo;
      targetOwner: PackageOwner;
      workspacePackage: WorkspacePackage | null;
    }
  | {
      kind: 'artifact-package';
      packageInfo: NearestPackageInfo;
    }
  | {
      kind: 'unowned';
    };
