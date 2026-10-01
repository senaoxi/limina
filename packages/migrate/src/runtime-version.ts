import { createRequire } from 'node:module';
import { migrationBuildInfo } from './build-info';

function isMatchingBuild(installedVersion: string | undefined): boolean {
  const { coreVersion, migrateVersion } = migrationBuildInfo;
  return coreVersion === migrateVersion && installedVersion === migrateVersion;
}

export function assertRuntimeVersion(): void {
  const installed = createRequire(import.meta.url)(
    'limina-migrate/package.json',
  ) as {
    version?: string;
  };
  const { coreVersion, migrateVersion } = migrationBuildInfo;
  if (!isMatchingBuild(installed.version)) {
    throw new Error(
      `Invalid limina-migrate build: embedded Limina@${coreVersion}, embedded limina-migrate@${migrateVersion}, installed limina-migrate@${installed.version ?? 'unknown'}. Reinstall the matching release before migrating.`,
    );
  }
}
