import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execReleaseCommand } from './command';
import {
  getNpmCommand,
  isValidVersion,
  REPO_ROOT,
  runCommand,
  type ReleasePlan,
  type ResolvedReleasePackageConfig,
} from './shared';

const publicationDirectories = new Map([
  ['limina', 'packages/limina/dist'],
  ['limina-migrate', 'packages/migrate/dist'],
]);

interface PublishedManifest {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
}

function validatePublishedDependencies(manifest: PublishedManifest): void {
  for (const section of [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ]) {
    const entries = Object.entries(section ?? {});
    for (const [name, range] of entries) {
      const isMigrationCoreDependency =
        name === 'limina' && manifest.name === 'limina-migrate';
      if (
        isMigrationCoreDependency ||
        name.startsWith('@limina/') ||
        /^(?:workspace|link|file|catalog):/u.test(range)
      ) {
        throw new Error(
          `Published ${manifest.name} contains a workspace-only dependency: ${name}@${range}.`,
        );
      }
    }
  }
}

function validateMigrationBuild(
  config: ResolvedReleasePackageConfig,
  version: string,
): void {
  const buildPath = path.join(config.publishDir, 'migration-build.json');
  const build = JSON.parse(readFileSync(buildPath, 'utf8')) as {
    formatVersion?: unknown;
    coreVersion?: unknown;
    migrateVersion?: unknown;
  };
  const coreDirectory = path.join(REPO_ROOT, 'packages/limina');
  const coreSource = JSON.parse(
    readFileSync(path.join(coreDirectory, 'package.json'), 'utf8'),
  ) as PublishedManifest;
  const coreDistribution = JSON.parse(
    readFileSync(path.join(coreDirectory, 'dist/package.json'), 'utf8'),
  ) as PublishedManifest;
  if (
    build.formatVersion !== 1 ||
    build.coreVersion !== version ||
    build.migrateVersion !== version ||
    coreSource.name !== 'limina' ||
    coreDistribution.name !== 'limina' ||
    coreSource.version !== version ||
    coreDistribution.version !== version
  ) {
    throw new Error(
      'Published limina-migrate must embed the same-release Limina source and match both source and distribution versions.',
    );
  }
  for (const resource of [
    'cli.js',
    'bin/limina-migrate.js',
    'migration-verify-process.js',
    'flow-renderer-process.js',
    'LICENSE.md',
    'bundled-dependencies.json',
  ]) {
    if (!existsSync(path.join(config.publishDir, resource))) {
      throw new Error(
        `Published limina-migrate resource is unavailable: ${resource}.`,
      );
    }
  }
}

export function validatePublicationTarget(
  config: ResolvedReleasePackageConfig,
  version: string,
  gitTag: string,
): void {
  const relativeDirectory = publicationDirectories.get(config.packageName);
  if (
    !relativeDirectory ||
    !isValidVersion(version) ||
    gitTag !== `limina/v${version}` ||
    realpathSync(config.publishDir) !==
      path.join(realpathSync(REPO_ROOT), relativeDirectory)
  ) {
    throw new Error(
      'Publication requires an approved package directory and the matching limina version tag.',
    );
  }
  const source = JSON.parse(readFileSync(config.manifestPath, 'utf8')) as {
    name?: string;
    version?: string;
  };
  const distribution = JSON.parse(
    readFileSync(path.join(config.publishDir, 'package.json'), 'utf8'),
  ) as PublishedManifest;
  if (
    source.name !== config.packageName ||
    source.version !== version ||
    distribution.name !== source.name ||
    distribution.version !== version
  ) {
    throw new Error(
      `Source and published package must agree: ${config.packageName}@${version}`,
    );
  }
  validatePublishedDependencies(distribution);
  if (config.packageName === 'limina-migrate')
    validateMigrationBuild(config, version);
  if (
    config.packageName === 'limina' &&
    Object.keys(distribution.exports ?? {}).some(
      (key) => key === './internal' || key.startsWith('./internal/'),
    )
  ) {
    throw new Error(
      'Published Limina must not export workspace-only internal support.',
    );
  }
}

export function assertReleaseGroup(plans: ReleasePlan[]): void {
  if (
    plans.length !== 2 ||
    new Set(plans.map((plan) => plan.config.packageName)).size !== 2 ||
    plans.some(
      (plan) => !publicationDirectories.has(plan.config.packageName),
    ) ||
    new Set(plans.map((plan) => plan.newVersion)).size !== 1 ||
    new Set(plans.map((plan) => plan.npmTag ?? 'latest')).size !== 1
  ) {
    throw new Error(
      'Publication requires both packages at one version and one channel.',
    );
  }
}

function registryArguments(registry?: string): string[] {
  return registry ? ['--registry', registry] : [];
}

function registryIntegrity(
  plan: ReleasePlan,
  registry?: string,
): string | undefined {
  let output: string;
  try {
    output = execReleaseCommand(
      getNpmCommand(),
      [
        'view',
        `${plan.config.packageName}@${plan.newVersion}`,
        'dist.integrity',
        '--json',
        ...registryArguments(registry),
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    const stdout = (error as { stdout?: Buffer | string }).stdout?.toString();
    if (stdout) {
      const value = JSON.parse(stdout) as { error?: { code?: string } };
      if (value.error?.code === 'E404') return undefined;
    }
    throw error;
  }
  const value: unknown = JSON.parse(output);
  if (typeof value !== 'string' || !value.startsWith('sha512-')) {
    throw new Error(
      `Registry integrity is unavailable for ${plan.config.packageName}@${plan.newVersion}`,
    );
  }
  return value;
}

export function publishReleaseGroup(
  plans: ReleasePlan[],
  options: {
    registry?: string;
    provenance: boolean;
  },
): void {
  assertReleaseGroup(plans);
  for (const plan of plans)
    validatePublicationTarget(plan.config, plan.newVersion, plan.gitTag);
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), 'limina-release-'),
  );
  try {
    const packages = plans.map((plan) => {
      const packed = JSON.parse(
        runCommand(
          getNpmCommand(),
          ['pack', '--json', '--pack-destination', temporaryDirectory],
          {
            cwd: plan.config.publishDir,
          },
        ),
      ) as { integrity: string; filename: string }[];
      const pack = packed[0];
      if (packed.length !== 1 || !pack?.integrity.startsWith('sha512-'))
        throw new Error(
          'npm pack did not produce one integrity-checked artifact.',
        );
      return { plan, integrity: pack.integrity };
    });
    const candidateTag = `limina-candidate-${plans[0]!.newVersion}`;
    // Preflight the entire group before uploading any missing member.
    const existing = packages.map(({ plan, integrity }) => {
      const published = registryIntegrity(plan, options.registry);
      if (published !== undefined && published !== integrity)
        throw new Error(
          `Published artifact differs: ${plan.config.packageName}@${plan.newVersion}`,
        );
      return published !== undefined;
    });
    for (const [index, { plan, integrity }] of packages.entries()) {
      if (!existing[index]) {
        runCommand(
          getNpmCommand(),
          [
            'publish',
            '--access',
            'public',
            '--tag',
            candidateTag,
            ...registryArguments(options.registry),
            ...(options.provenance ? ['--provenance'] : []),
          ],
          { cwd: plan.config.publishDir, stdio: 'inherit' },
        );
      }
      if (registryIntegrity(plan, options.registry) !== integrity)
        throw new Error(
          `Published integrity did not match ${plan.config.packageName}. Channels were not promoted.`,
        );
    }
    // Both immutable versions are now available; interruption here is safely retryable.
    for (const { plan } of packages) {
      runCommand(
        getNpmCommand(),
        [
          'dist-tag',
          'add',
          `${plan.config.packageName}@${plan.newVersion}`,
          plan.npmTag ?? 'latest',
          ...registryArguments(options.registry),
        ],
        { cwd: REPO_ROOT, stdio: 'inherit' },
      );
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
