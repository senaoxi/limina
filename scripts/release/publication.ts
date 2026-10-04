import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { execReleaseCommand } from './command';
import {
  assertValidNpmTag,
  getNpmCommand,
  isValidVersion,
  ReleaseLogger,
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
  assertValidNpmTag(plans[0]!.npmTag ?? 'latest');
}

function registryArguments(registry?: string): string[] {
  return registry ? ['--registry', registry] : [];
}

function registryOutput(
  arguments_: string[],
  registry?: string,
): string | undefined {
  let output: string;
  try {
    output = execReleaseCommand(
      getNpmCommand(),
      [...arguments_, '--json', ...registryArguments(registry)],
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
  return output;
}

function registryIntegrity(
  plan: ReleasePlan,
  registry?: string,
): string | undefined {
  const output = registryOutput(
    ['view', `${plan.config.packageName}@${plan.newVersion}`, 'dist.integrity'],
    registry,
  );
  if (output === undefined) return undefined;
  const value: unknown = JSON.parse(output);
  if (typeof value !== 'string' || !value.startsWith('sha512-')) {
    throw new Error(
      `Registry integrity is unavailable for ${plan.config.packageName}@${plan.newVersion}`,
    );
  }
  return value;
}

function waitForPublishedIntegrity(
  plan: ReleasePlan,
  registry?: string,
): string {
  const deadline = performance.now() + 300_000;
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  let hasReportedWait = false;
  while (performance.now() < deadline) {
    const integrity = registryIntegrity(plan, registry);
    if (integrity !== undefined) return integrity;
    if (!hasReportedWait) {
      ReleaseLogger.info(
        `Waiting up to five minutes for npm metadata: ${plan.config.packageName}@${plan.newVersion}`,
      );
      hasReportedWait = true;
    }
    const remaining = deadline - performance.now();
    if (remaining > 0)
      Atomics.wait(waitBuffer, 0, 0, Math.min(5000, remaining));
  }
  throw new Error(
    `Published version did not become visible within five minutes: ${plan.config.packageName}@${plan.newVersion}. Channels were not promoted.`,
  );
}

function registryTags(
  plan: ReleasePlan,
  registry?: string,
): Record<string, string> {
  // `npm view name dist-tags` silently returns no output when a newly
  // published package has a candidate tag but no latest version yet.
  const output = registryOutput(
    ['dist-tag', 'ls', plan.config.packageName],
    registry,
  );
  if (output === undefined) return {};
  return Object.fromEntries(
    output
      .trim()
      .split('\n')
      .map((line) => {
        const entry = /^([^\s:]+): (\S+)$/u.exec(line);
        if (!entry || !isValidVersion(entry[2]!))
          throw new Error(
            `Registry channels are unavailable for ${plan.config.packageName}.`,
          );
        return [entry[1]!, entry[2]!];
      }),
  );
}

interface PublicationMemberEvidence {
  name: string;
  version: string;
  filename?: string;
  integrity?: string;
  registryIntegrity: string | null;
  tagsBefore?: Record<string, string>;
  tagsAfter?: Record<string, string>;
}

export function publishReleaseGroup(
  plans: ReleasePlan[],
  options: {
    registry?: string;
    provenance: boolean;
    evidenceDirectory?: string;
  },
): void {
  assertReleaseGroup(plans);
  for (const plan of plans)
    validatePublicationTarget(plan.config, plan.newVersion, plan.gitTag);
  if (options.evidenceDirectory)
    mkdirSync(options.evidenceDirectory, { recursive: true });
  const temporaryDirectory = mkdtempSync(
    path.join(options.evidenceDirectory ?? tmpdir(), 'limina-release-'),
  );
  const candidateTag = `limina-candidate-${plans[0]!.newVersion}`;
  const evidence = {
    gitTag: plans[0]!.gitTag,
    channel: plans[0]!.npmTag ?? 'latest',
    candidateTag,
    status: 'in-progress',
    phase: 'pack',
    activePackage: '',
    packages: plans.map<PublicationMemberEvidence>((plan) => ({
      name: plan.config.packageName,
      version: plan.newVersion,
      registryIntegrity: null,
    })),
  };
  const saveEvidence = () => {
    if (options.evidenceDirectory)
      writeFileSync(
        path.join(temporaryDirectory, 'publication.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
      );
  };
  saveEvidence();
  try {
    const packages = plans.map((plan, index) => {
      evidence.activePackage = plan.config.packageName;
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
      const member = evidence.packages[index]!;
      member.filename = pack.filename;
      member.integrity = pack.integrity;
      saveEvidence();
      return {
        plan,
        integrity: pack.integrity,
        filename: pack.filename,
        member,
      };
    });
    // Preflight the entire group before uploading any missing member.
    evidence.phase = 'preflight';
    const existing = packages.map(({ plan, integrity, member }) => {
      evidence.activePackage = plan.config.packageName;
      const published = registryIntegrity(plan, options.registry);
      member.registryIntegrity = published ?? null;
      member.tagsBefore = registryTags(plan, options.registry);
      saveEvidence();
      if (published !== undefined && published !== integrity)
        throw new Error(
          `Published artifact differs: ${plan.config.packageName}@${plan.newVersion}`,
        );
      return published !== undefined;
    });
    evidence.phase = 'upload';
    for (const [
      index,
      { plan, integrity, filename, member },
    ] of packages.entries()) {
      evidence.activePackage = plan.config.packageName;
      saveEvidence();
      if (!existing[index]) {
        try {
          runCommand(
            getNpmCommand(),
            [
              'publish',
              path.join(temporaryDirectory, filename),
              '--access',
              'public',
              '--tag',
              candidateTag,
              ...registryArguments(options.registry),
              ...(options.provenance ? ['--provenance'] : []),
            ],
            { cwd: plan.config.publishDir, stdio: 'inherit' },
          );
        } catch (error) {
          // A failed client response does not prove the immutable upload failed.
          member.registryIntegrity =
            registryIntegrity(plan, options.registry) ?? null;
          saveEvidence();
          throw error;
        }
      }
      member.registryIntegrity = waitForPublishedIntegrity(
        plan,
        options.registry,
      );
      saveEvidence();
      if (member.registryIntegrity !== integrity)
        throw new Error(
          `Published integrity did not match ${plan.config.packageName}. Channels were not promoted.`,
        );
    }
    // Both immutable versions are now available; interruption here is safely retryable.
    evidence.phase = 'promote';
    for (const { plan, member } of packages) {
      evidence.activePackage = plan.config.packageName;
      saveEvidence();
      try {
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
      } finally {
        member.tagsAfter = registryTags(plan, options.registry);
        saveEvidence();
      }
      if (member.tagsAfter[plan.npmTag ?? 'latest'] !== plan.newVersion)
        throw new Error(
          `Channel verification failed for ${plan.config.packageName}.`,
        );
    }
    evidence.phase = 'verify-channels';
    for (const [index, { plan, member }] of packages.entries()) {
      evidence.activePackage = plan.config.packageName;
      member.tagsAfter = registryTags(plan, options.registry);
      saveEvidence();
      if (member.tagsAfter[plan.npmTag ?? 'latest'] !== plan.newVersion)
        throw new Error(
          `Channel verification failed for ${plan.config.packageName}.`,
        );
      // npm requires a latest tag when the namespace is first created, even
      // when the upload uses a candidate tag. An established latest stays fixed.
      const isRegistryBootstrap =
        !existing[index] &&
        Object.keys(member.tagsBefore!).length === 0 &&
        member.tagsAfter.latest === plan.newVersion;
      if (
        !isRegistryBootstrap &&
        (plan.npmTag ?? 'latest') !== 'latest' &&
        member.tagsAfter.latest !== member.tagsBefore!.latest
      )
        throw new Error(
          `Latest channel changed for ${plan.config.packageName}: expected ${member.tagsBefore!.latest ?? 'absent'}, received ${member.tagsAfter.latest ?? 'absent'}.`,
        );
    }
    evidence.status = 'complete';
    evidence.phase = 'complete';
    evidence.activePackage = '';
    saveEvidence();
  } catch (error) {
    evidence.status = 'failed';
    saveEvidence();
    throw error;
  } finally {
    if (!options.evidenceDirectory)
      rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
