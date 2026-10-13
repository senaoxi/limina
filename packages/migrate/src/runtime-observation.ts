import type { ResolvedLiminaInputs } from 'limina/internal/config/runner';
import type { LiminaFlowReporter } from 'limina/internal/flow';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { migrationBuildInfo } from './build-info';

interface PackageObservation {
  status:
    | 'observed-same-version'
    | 'observed-different-version'
    | 'not-installed'
    | 'unavailable';
  manifestPath?: string;
  version?: string;
}

function isAvailableVersion(version: unknown): version is string {
  return typeof version === 'string' && version.trim().length > 0;
}

function isValidMetadata(
  manifest: { name?: unknown; version?: unknown },
  name: string,
): manifest is { name: string; version: string } {
  return manifest.name === name && isAvailableVersion(manifest.version);
}

function observedVersionStatus(
  version: string,
  expectedVersion: string | undefined,
): PackageObservation['status'] {
  if (expectedVersion === undefined) return 'observed-same-version';
  return version === expectedVersion
    ? 'observed-same-version'
    : 'observed-different-version';
}

function isModuleNotFound(error: Error): boolean {
  return 'code' in error && error.code === 'MODULE_NOT_FOUND';
}

function failedObservationStatus(error: unknown): PackageObservation['status'] {
  if (!(error instanceof Error)) return 'unavailable';
  return isModuleNotFound(error) ? 'not-installed' : 'unavailable';
}

function observePackage(
  anchor: string | URL,
  name: string,
  expectedVersion?: string,
): PackageObservation {
  try {
    const manifestPath = createRequire(anchor).resolve(`${name}/package.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
    if (!isValidMetadata(manifest, name)) {
      return { status: 'unavailable', manifestPath };
    }
    return {
      status: observedVersionStatus(manifest.version, expectedVersion),
      manifestPath,
      version: manifest.version,
    };
  } catch (error) {
    return {
      status: failedObservationStatus(error),
    };
  }
}

function versionDescription(version: string | undefined): string {
  return version === undefined
    ? 'Project Limina version'
    : `Project Limina@${version}`;
}

function reportObservation(
  flow: LiminaFlowReporter,
  anchor: string,
  label: string,
): void {
  const observation = observePackage(
    anchor,
    'limina',
    migrationBuildInfo.coreVersion,
  );
  const location = observation.manifestPath ?? anchor;
  const description = versionDescription(observation.version);
  const message = `${description}: ${observation.status} from ${label} (${location}). This is package metadata; the project runtime is not the verification target.`;
  if (observation.status === 'observed-same-version') flow.info(message);
  else flow.warn(message);
}

function reportCompiler(flow: LiminaFlowReporter): void {
  const compiler = observePackage(import.meta.url, 'typescript');
  flow.info(
    compiler.version === undefined
      ? `TypeScript peer metadata: ${compiler.status} from the migration installation.`
      : `TypeScript peer@${compiler.version}: ${compiler.manifestPath} (migration installation).`,
  );
}

function reportProjectVersions(
  config: ResolvedLiminaInputs,
  flow: LiminaFlowReporter,
): void {
  const rootAnchor = config.governanceRoot.manifestPath;
  if (config.configPath === undefined) {
    reportObservation(flow, rootAnchor, 'governance root (defaults)');
    return;
  }
  reportConfigProjectVersions({
    config,
    configPath: config.configPath,
    flow,
    rootAnchor,
  });
}

function reportConfigProjectVersions(options: {
  config: ResolvedLiminaInputs;
  configPath: string;
  flow: LiminaFlowReporter;
  rootAnchor: string;
}): void {
  const { configPath, flow, rootAnchor } = options;
  const hasSharedDirectory =
    path.dirname(configPath) === path.dirname(rootAnchor);
  reportObservation(
    flow,
    configPath,
    hasSharedDirectory ? 'config and governance root' : 'config',
  );
  if (!hasSharedDirectory)
    reportObservation(flow, rootAnchor, 'governance root');
}

function reportSchemaAvailability(
  config: ResolvedLiminaInputs,
  flow: LiminaFlowReporter,
): void {
  if (
    !existsSync(
      path.join(
        config.governanceRoot.rootDir,
        'node_modules/limina/schemas/tsconfig-schema.json',
      ),
    )
  ) {
    flow.warn(
      'Persisted $schema paths refer to node_modules/limina/schemas/tsconfig-schema.json. Editor schema resolution may be unavailable until Limina is installed in the project; embedded input verification remains independent.',
    );
  }
}

export function reportRuntimeObservations(
  config: ResolvedLiminaInputs,
  flow: LiminaFlowReporter,
): void {
  flow.info(
    `Input verification uses embedded Limina@${migrationBuildInfo.coreVersion} from the limina-migrate@${migrationBuildInfo.migrateVersion} release.`,
  );
  reportCompiler(flow);
  reportProjectVersions(config, flow);
  reportSchemaAvailability(config, flow);
}
