import { isLocalPackageDependencySpecifier } from '#core/workspace/actions';
import { toRelativePath } from '#utils/path';
import path from 'pathe';
import { LIMINA_CHECK_ISSUE_CODES } from '../../check-reporting/codes';
import { formatErrorMessage, ReleaseLogger } from '../../logger';
import {
  assertPackageReleaseConsistency,
  PackageReleaseConsistencyError,
} from '../../package-check/release-consistency';
import {
  createReleaseCheckIssuesFromFindings,
  createReleaseFinding,
  type ReleaseDependencySectionName,
  type ReleaseFinding,
} from '../../package-check/release-findings';
import {
  type DistPackageJson,
  type PackedPackageTarball,
  readDistPackageJson,
} from '../../package-check/runner';
import { packReleaseTarball } from './tarball';
import type { ReleaseEntryOptions } from './types';

interface ReleaseEntryTask {
  fail(reason: string, details?: { error: unknown }): void;
  pass(): void;
}

const dependencySections: readonly ReleaseDependencySectionName[] = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

function isDependencyRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isLocalSpecifierEntry(
  entry: readonly [string, unknown],
): entry is [string, string] {
  return (
    typeof entry[1] === 'string' && isLocalPackageDependencySpecifier(entry[1])
  );
}

function createOutputSpecifierFinding(options: {
  dependencyName: string;
  entry: ReleaseEntryOptions;
  manifest: DistPackageJson;
  packageManifestPath: string;
  sectionName: ReleaseDependencySectionName;
  specifier: string;
}): ReleaseFinding {
  const problemLines = [
    `${options.entry.label}: ${options.manifest.name} -> ${options.dependencyName} [${options.sectionName}] (${options.specifier}): output package manifest must not expose workspace:, link:, file:, or catalog: dependency specifiers`,
    `  output: ${toRelativePath(options.entry.config.rootDir, options.entry.outDir)}`,
  ];
  return createReleaseFinding({
    code: LIMINA_CHECK_ISSUE_CODES.releasePackedManifest,
    facts: {
      dependencyName: options.dependencyName,
      kind: 'output-local-specifier',
      outputDirectory: options.entry.outDir,
      packageManifestPath: options.packageManifestPath,
      sectionName: options.sectionName,
      specifier: options.specifier,
    },
    filePath: options.packageManifestPath,
    packageManifestPath: options.packageManifestPath,
    packageName: options.manifest.name,
    presentation: {
      problemLines,
      section: 'output-manifest',
      sectionTitle: 'Output package manifest is not publish-ready:',
      summary: problemLines[0]!,
      title: 'Output package manifest is not publish-ready',
    },
  });
}

function collectSectionFindings(options: {
  entry: ReleaseEntryOptions;
  manifest: DistPackageJson;
  packageManifestPath: string;
  sectionName: ReleaseDependencySectionName;
}): ReleaseFinding[] {
  const section = options.manifest[options.sectionName];

  if (!isDependencyRecord(section)) {
    return [];
  }

  return Object.entries(section)
    .filter(isLocalSpecifierEntry)
    .map(([dependencyName, specifier]) =>
      createOutputSpecifierFinding({
        dependencyName,
        entry: options.entry,
        manifest: options.manifest,
        packageManifestPath: options.packageManifestPath,
        sectionName: options.sectionName,
        specifier,
      }),
    );
}

function collectOutputManifestFindings(
  entry: ReleaseEntryOptions,
  manifest: DistPackageJson,
  packageManifestPath: string,
): ReleaseFinding[] {
  return dependencySections.flatMap((sectionName) =>
    collectSectionFindings({
      entry,
      manifest,
      packageManifestPath,
      sectionName,
    }),
  );
}

function createPrivateOutputFinding(options: {
  manifest: DistPackageJson;
  packageManifestPath: string;
}): ReleaseFinding {
  const problemLine = `${options.manifest.name}: selected release package has "private": true; npm publish would reject it`;
  return createReleaseFinding({
    code: LIMINA_CHECK_ISSUE_CODES.releaseTarballHygiene,
    facts: {
      kind: 'output-private',
      packageManifestPath: options.packageManifestPath,
    },
    filePath: options.packageManifestPath,
    packageManifestPath: options.packageManifestPath,
    packageName: options.manifest.name,
    presentation: {
      problemLines: [problemLine],
      section: 'tarball',
      sectionTitle: 'Release tarball is not publishable:',
      summary: problemLine,
      title: 'Release tarball is not publishable',
    },
  });
}

function createConsistencyError(
  findings: readonly ReleaseFinding[],
  entry: ReleaseEntryOptions,
): PackageReleaseConsistencyError {
  return new PackageReleaseConsistencyError([...findings], {
    label: entry.label,
    outDir: entry.outDir,
    rootDir: entry.config.rootDir,
  });
}

function assertOutputManifest(
  entry: ReleaseEntryOptions,
  manifest: DistPackageJson,
  packageManifestPath: string,
): void {
  const findings = collectOutputManifestFindings(
    entry,
    manifest,
    packageManifestPath,
  );

  if (findings.length > 0) {
    throw createConsistencyError(findings, entry);
  }

  if (manifest.private === true) {
    throw createConsistencyError(
      [createPrivateOutputFinding({ manifest, packageManifestPath })],
      entry,
    );
  }
}

async function assertPackedRelease(options: {
  entry: ReleaseEntryOptions;
  manifest: DistPackageJson;
  packed: PackedPackageTarball;
}): Promise<void> {
  await assertPackageReleaseConsistency({
    config: options.entry.config,
    label: options.entry.label,
    outDir: options.entry.outDir,
    outputManifest: options.manifest,
    packedTarball: options.packed.tarball,
    packedTarballPath: options.packed.tarballPath,
    workspacePackages: options.entry.workspacePackages,
  });
}

async function executeReleaseEntry(entry: ReleaseEntryOptions): Promise<void> {
  const packageManifestPath = path.join(entry.outDir, 'package.json');
  const manifest = await readDistPackageJson({
    config: entry.config,
    label: entry.label,
    packageJsonPath: packageManifestPath,
  });
  assertOutputManifest(entry, manifest, packageManifestPath);
  const packed = await packReleaseTarball(entry);

  try {
    await assertPackedRelease({ entry, manifest, packed });
  } finally {
    await packed.cleanup();
  }
}

function addConsistencyIssues(
  entry: ReleaseEntryOptions,
  error: PackageReleaseConsistencyError,
): void {
  entry.issueSink?.push(
    ...createReleaseCheckIssuesFromFindings({
      findings: error.findings,
      rootDir: entry.config.rootDir,
    }),
  );
}

function passTask(task: ReleaseEntryTask | undefined): void {
  task?.pass();
}

function failTask(
  task: ReleaseEntryTask | undefined,
  reason: string,
  details?: { error: unknown },
): void {
  task?.fail(reason, details);
}

function getEntryFlowDepth(depth: number | undefined): number {
  return depth === undefined ? 1 : depth + 1;
}

function createEntryTask(
  entry: ReleaseEntryOptions,
): ReleaseEntryTask | undefined {
  if (entry.progressItem !== undefined) {
    return undefined;
  }

  if (entry.flow === undefined) {
    return undefined;
  }

  return entry.flow.start(`release entry: ${entry.label}`, {
    depth: getEntryFlowDepth(entry.flowDepth),
  });
}

function logEntrySuccess(entry: ReleaseEntryOptions): void {
  if (entry.flow?.interactive !== true) {
    ReleaseLogger.success(`release checks passed: ${entry.label}`);
  }
}

function handleEntryFailure(
  entry: ReleaseEntryOptions,
  task: ReleaseEntryTask | undefined,
  error: unknown,
): false {
  if (error instanceof PackageReleaseConsistencyError) {
    addConsistencyIssues(entry, error);
    ReleaseLogger.error(formatErrorMessage(error));
    failTask(task, `release checks failed: ${entry.label}`);
    return false;
  }

  ReleaseLogger.error(
    `release checks failed: ${entry.label}: ${formatErrorMessage(error)}`,
  );
  failTask(task, `release checks failed: ${entry.label}`, { error });
  throw error;
}

export async function runReleaseCheckEntry(
  entry: ReleaseEntryOptions,
): Promise<boolean> {
  const task = createEntryTask(entry);

  try {
    await executeReleaseEntry(entry);
    logEntrySuccess(entry);
    passTask(task);
    return true;
  } catch (error) {
    return handleEntryFailure(entry, task, error);
  }
}
