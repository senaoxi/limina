import corePackage from '../../limina/package.json' with { type: 'json' };
import migratePackage from '../package.json' with { type: 'json' };

export interface MigrationBuildInfo {
  readonly formatVersion: 1;
  readonly coreVersion: string;
  readonly migrateVersion: string;
}

// These are the two source manifests, bundled with the implementation. The
// installed self manifest is read separately by the runtime integrity guard.
export const migrationBuildInfo: MigrationBuildInfo = Object.freeze({
  formatVersion: 1,
  coreVersion: corePackage.version,
  migrateVersion: migratePackage.version,
});
