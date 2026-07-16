import type { RegionExcludeConfig, ResolvedLiminaConfig } from '#config/runner';
import { readJsonConfig } from '#core/tsconfig/actions';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  normalizeSlashes,
  toRelativePath,
} from '#utils/path';
import { isPlainRecord } from '#utils/values';
import { existsSync, realpathSync } from 'node:fs';
import { lstat, opendir, readFile, realpath } from 'node:fs/promises';
import path from 'pathe';
import rawPicomatch from 'picomatch';
import { LiminaStructuredError } from '../../check-reporting/errors';
import { createLiminaCheckIssue } from '../../check-reporting/structured';
import type { LiminaCheckIssue } from '../../source-check/snapshot';
import type { PackageManifest, WorkspacePackage } from './actions';
import type {
  ExtendedPackageScope,
  PackageScopeRegionBoundary,
  PnpmWorkspaceRegionBoundary,
  WorkspaceRegionBoundary,
  WorkspaceRegionTopology,
} from './regions';

const readableTsconfigCandidateBrand: unique symbol = Symbol(
  'ReadableWorkspaceTsconfigCandidate',
);

export interface ReadableWorkspaceTsconfigCandidate {
  readonly [readableTsconfigCandidateBrand]: true;
  readonly ownerDirectory: string;
  readonly path: string;
}

type WorkspaceTsconfigOutputRootRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'output'; readonly outputRoot: string };

export type WorkspaceDescriptorKind =
  | 'package-json'
  | 'pnpm-workspace'
  | 'tsconfig';

export interface WorkspaceDescriptorCandidate {
  readonly canonicalPath: string;
  readonly displayPath: string;
  readonly kind: WorkspaceDescriptorKind;
  readonly ownerDirectory: string;
  readonly path: string;
  readonly rootDir: string;
}

export interface WorkspacePackageIdentity {
  readonly canonicalDirectory: string;
  readonly displayDirectory: string;
  readonly package: WorkspacePackage;
}

export interface ValidatedWorkspaceContext extends WorkspaceRegionTopology {
  readonly configRootDir: string;
  readonly descriptorCandidates: readonly WorkspaceDescriptorCandidate[];
  readonly outputRoots: readonly string[];
  readonly packageIdentities: readonly WorkspacePackageIdentity[];
  readonly sourceConfigPaths: readonly string[];
  readonly workspaceRootDir: string;
}

export interface WorkspaceIndexMetricsRecorder {
  record(measurement: {
    readonly count?: number;
    readonly kind?: string;
    readonly name:
      | 'canonical-path-cache-hit'
      | 'canonical-path-cache-miss'
      | 'canonical-path'
      | 'provider-cache-hit'
      | 'provider-cache-miss'
      | 'workspace-negative-lookup';
    readonly provider?: string;
  }): void;
}

interface PackageIslandCollection {
  boundaries: PackageScopeRegionBoundary[];
  descriptors: WorkspaceDescriptorCandidate[];
  extendedScopes: ExtendedPackageScope[];
  pnpmBoundaries: PnpmWorkspaceRegionBoundary[];
}

interface CompiledExclusionRule {
  entry: RegionExcludeConfig;
  index: number;
  matchers: ((value: string) => boolean)[];
}

const picomatch = rawPicomatch as unknown as (
  pattern: string,
  options?: { dot?: boolean; posixSlashes?: boolean },
) => (value: string) => boolean;

function findNearestPnpmWorkspaceRoot(startDir: string): string {
  let currentDir = normalizeAbsolutePath(startDir);
  while (true) {
    if (existsSync(path.join(currentDir, 'pnpm-workspace.yaml'))) {
      return currentDir;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(
        `No pnpm-workspace.yaml was found from ${normalizeAbsolutePath(startDir)} or its ancestors.`,
      );
    }
    currentDir = parentDir;
  }
}

function isInsideOrEqual(parentPath: string, childPath: string): boolean {
  const normalizedParent = normalizeAbsolutePath(parentPath);
  const normalizedChild = normalizeAbsolutePath(childPath);
  return (
    normalizedParent === normalizedChild ||
    isPathInsideDirectory(normalizedChild, normalizedParent)
  );
}

function displayPath(rootDir: string, targetPath: string): string {
  return normalizeSlashes(toRelativePath(rootDir, targetPath));
}

function createWorkspaceIssue(options: {
  code: string;
  config: ResolvedLiminaConfig;
  evidence?: readonly string[];
  filePath?: string;
  fix: string;
  reason: string;
  title: string;
}): LiminaCheckIssue {
  return createLiminaCheckIssue({
    code: options.code,
    ...(options.evidence?.length
      ? {
          evidence: [
            { label: 'workspace validation', lines: [...options.evidence] },
          ],
        }
      : {}),
    filePath: options.filePath,
    fix: options.fix,
    reason: options.reason,
    rootDir: options.config.rootDir,
    task: 'workspace:validate',
    title: options.title,
    verifyCommands: ['limina check'],
  });
}

async function canonicalProjectedPath(targetPath: string): Promise<string> {
  const normalizedTarget = normalizeAbsolutePath(targetPath);
  let cursor = normalizedTarget;
  const suffix: string[] = [];

  while (true) {
    try {
      return normalizeAbsolutePath(
        path.join(await realpath(cursor), ...suffix.toReversed()),
      );
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      ) {
        throw error;
      }
    }

    const parent = path.dirname(cursor);
    if (parent === cursor)
      throw new Error(`No existing ancestor for ${targetPath}.`);
    suffix.push(path.basename(cursor));
    cursor = parent;
  }
}

async function collectPackageIdentities(options: {
  config: ResolvedLiminaConfig;
  rawPackages: readonly WorkspacePackage[];
}): Promise<{
  identities: WorkspacePackageIdentity[];
  issues: LiminaCheckIssue[];
}> {
  const issues: LiminaCheckIssue[] = [];
  const identities = await Promise.all(
    options.rawPackages.map(async (workspacePackage) => ({
      canonicalDirectory: normalizeAbsolutePath(
        await realpath(workspacePackage.directory),
      ),
      displayDirectory: displayPath(
        options.config.rootDir,
        workspacePackage.directory,
      ),
      package: workspacePackage,
    })),
  );
  const byCanonicalDirectory = new Map<string, WorkspacePackageIdentity[]>();

  for (const identity of identities) {
    const group = byCanonicalDirectory.get(identity.canonicalDirectory) ?? [];
    group.push(identity);
    byCanonicalDirectory.set(identity.canonicalDirectory, group);
  }
  for (const [canonicalDirectory, group] of byCanonicalDirectory) {
    if (group.length < 2) continue;
    issues.push(
      createWorkspaceIssue({
        code: 'LIMINA_WORKSPACE_PACKAGE_IDENTITY_CONFLICT',
        config: options.config,
        evidence: [
          `canonical root: ${canonicalDirectory}`,
          ...group.map(
            (identity) => `lexical root: ${identity.displayDirectory}`,
          ),
        ],
        filePath: path.join(group[0]!.package.directory, 'package.json'),
        fix: 'Remove duplicate or symlink-alias workspace package roots.',
        reason:
          'Two activated workspace package roots resolve to the same physical directory.',
        title: 'Workspace package identity conflict',
      }),
    );
  }

  return { identities, issues };
}

async function collectSameRootOverlapIssues(options: {
  config: ResolvedLiminaConfig;
  rawPackages: readonly WorkspacePackage[];
}): Promise<LiminaCheckIssue[]> {
  const configRootDir = normalizeAbsolutePath(options.config.rootDir);
  const workspaceRootDir = findNearestPnpmWorkspaceRoot(configRootDir);
  const issues: LiminaCheckIssue[] = [];

  for (const workspacePackage of options.rawPackages) {
    const packageRoot = normalizeAbsolutePath(workspacePackage.directory);
    if (packageRoot === workspaceRootDir) continue;
    const workspaceYamlPath = path.join(packageRoot, 'pnpm-workspace.yaml');
    try {
      const stats = await lstat(workspaceYamlPath);
      if (!stats.isFile()) continue;
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        continue;
      }
      throw error;
    }

    issues.push(
      createWorkspaceIssue({
        code: 'LIMINA_WORKSPACE_REGION_OVERLAP',
        config: options.config,
        evidence: [
          `raw workspace package: ${displayPath(configRootDir, packageRoot)}`,
          `workspace descriptor: ${displayPath(configRootDir, workspaceYamlPath)}`,
        ],
        filePath: workspaceYamlPath,
        fix: 'Remove the overlapping raw workspace membership or the package-root pnpm-workspace.yaml.',
        reason:
          'A raw non-root workspace package is also the root of a pnpm workspace.',
        title: 'Workspace package and workspace root overlap',
      }),
    );
  }
  return issues;
}

function compileExclusionRules(
  config: ResolvedLiminaConfig,
): CompiledExclusionRule[] {
  return (config.regions?.exclude ?? []).map((entry, index) => ({
    entry,
    index,
    matchers: entry.include.map((pattern) =>
      picomatch(normalizeSlashes(pattern.trim()).replaceAll(/^\.\//gu, ''), {
        dot: true,
        posixSlashes: true,
      }),
    ),
  }));
}

function findExactExclusions(options: {
  config: ResolvedLiminaConfig;
  kind: 'package-scope' | 'workspace-package';
  rootDir: string;
  rules: CompiledExclusionRule[];
}): CompiledExclusionRule[] {
  const relativeRoot = displayPath(options.config.rootDir, options.rootDir);
  const matches = options.rules.filter(
    (rule) =>
      rule.entry.kind === options.kind &&
      rule.matchers.some((matchesPattern) => matchesPattern(relativeRoot)),
  );
  return matches;
}

function applyWorkspacePackageExclusions(options: {
  config: ResolvedLiminaConfig;
  rawPackages: readonly WorkspacePackage[];
  rules: CompiledExclusionRule[];
}): WorkspacePackage[] {
  return options.rawPackages.filter(
    (workspacePackage) =>
      findExactExclusions({
        config: options.config,
        kind: 'workspace-package',
        rootDir: workspacePackage.directory,
        rules: options.rules,
      }).length === 0,
  );
}

async function readPackageManifest(
  packageJsonPath: string,
): Promise<PackageManifest | null> {
  try {
    return JSON.parse(
      (await readFile(packageJsonPath, 'utf8')).replace(/^\uFEFF/u, ''),
    ) as PackageManifest;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function createDescriptorCandidate(options: {
  config: ResolvedLiminaConfig;
  kind: WorkspaceDescriptorKind;
  ownerDirectory: string;
  path: string;
  rootDir: string;
}): Promise<WorkspaceDescriptorCandidate> {
  return {
    canonicalPath: normalizeAbsolutePath(await realpath(options.path)),
    displayPath: displayPath(options.config.rootDir, options.path),
    kind: options.kind,
    ownerDirectory: options.ownerDirectory,
    path: normalizeAbsolutePath(options.path),
    rootDir: normalizeAbsolutePath(options.rootDir),
  };
}

function hasChildPackageRoot(options: {
  childRoots: readonly string[];
  directory: string;
}): boolean {
  const directory = normalizeAbsolutePath(options.directory);
  return options.childRoots.some(
    (childRoot) => normalizeAbsolutePath(childRoot) === directory,
  );
}

async function collectPackageIsland(options: {
  activatedIdentities: readonly WorkspacePackageIdentity[];
  activatedPackages: readonly WorkspacePackage[];
  config: ResolvedLiminaConfig;
  owner: WorkspacePackage;
  rules: CompiledExclusionRule[];
}): Promise<PackageIslandCollection> {
  const ownerRootDir = normalizeAbsolutePath(options.owner.directory);
  const ownerCanonicalRootDir = options.activatedIdentities.find(
    (identity) => identity.package === options.owner,
  )!.canonicalDirectory;
  const childRoots = options.activatedPackages
    .map((workspacePackage) =>
      normalizeAbsolutePath(workspacePackage.directory),
    )
    .filter(
      (candidate) =>
        candidate !== ownerRootDir && isInsideOrEqual(ownerRootDir, candidate),
    );
  const canonicalChildRoots = new Set(
    options.activatedIdentities
      .map((identity) => identity.canonicalDirectory)
      .filter(
        (candidate) =>
          candidate !== ownerCanonicalRootDir &&
          isInsideOrEqual(ownerCanonicalRootDir, candidate),
      ),
  );
  const result: PackageIslandCollection = {
    boundaries: [],
    descriptors: [],
    extendedScopes: [],
    pnpmBoundaries: [],
  };

  const walk = async (
    directory: string,
    isOwnerRoot: boolean,
  ): Promise<void> => {
    if (
      !isOwnerRoot &&
      (hasChildPackageRoot({ childRoots, directory }) ||
        canonicalChildRoots.has(
          normalizeAbsolutePath(await realpath(directory)),
        ))
    ) {
      return;
    }
    let entries;
    try {
      entries = await opendir(directory);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return;
      }
      throw error;
    }
    const names = new Map<string, Awaited<ReturnType<typeof lstat>>>();
    for await (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(directory, entry.name);
      names.set(entry.name, await lstat(entryPath));
    }

    const workspaceYamlPath = path.join(directory, 'pnpm-workspace.yaml');
    if (isOwnerRoot && names.get('pnpm-workspace.yaml')?.isFile()) {
      result.descriptors.push(
        await createDescriptorCandidate({
          config: options.config,
          kind: 'pnpm-workspace',
          ownerDirectory: ownerRootDir,
          path: workspaceYamlPath,
          rootDir: directory,
        }),
      );
    }
    if (!isOwnerRoot && names.get('pnpm-workspace.yaml')?.isFile()) {
      const boundary: PnpmWorkspaceRegionBoundary = {
        inspection: {
          reason: 'Nested workspace context is discovered independently.',
          status: 'excluded',
        },
        kind: 'pnpm-workspace',
        rootDir: directory,
        workspaceYamlPath,
      };
      result.pnpmBoundaries.push(boundary);
      result.descriptors.push(
        await createDescriptorCandidate({
          config: options.config,
          kind: 'pnpm-workspace',
          ownerDirectory: ownerRootDir,
          path: workspaceYamlPath,
          rootDir: directory,
        }),
      );
      return;
    }

    const packageJsonPath = path.join(directory, 'package.json');
    if (names.get('package.json')?.isFile()) {
      result.descriptors.push(
        await createDescriptorCandidate({
          config: options.config,
          kind: 'package-json',
          ownerDirectory: ownerRootDir,
          path: packageJsonPath,
          rootDir: directory,
        }),
      );
      if (!isOwnerRoot) {
        const manifest = await readPackageManifest(packageJsonPath);
        const expandable =
          options.config.regions?.extendNestedPackageScopes === true &&
          manifest !== null &&
          !Object.hasOwn(manifest, 'name');
        const exclusion = findExactExclusions({
          config: options.config,
          kind: 'package-scope',
          rootDir: directory,
          rules: options.rules,
        })[0];

        if (expandable && !exclusion) {
          result.extendedScopes.push({
            ownerDirectory: ownerRootDir,
            packageJsonPath,
            rootDir: directory,
          });
        } else {
          result.boundaries.push({
            excluded: Boolean(exclusion),
            ...(exclusion ? { exclusionReason: exclusion.entry.reason } : {}),
            kind: 'package-scope',
            packageJsonPath,
            rootDir: directory,
          });
          return;
        }
      }
    }

    for (const [name, stats] of names) {
      if (stats.isFile() && /^tsconfig(?:\.[^.]+)*\.json$/u.test(name)) {
        result.descriptors.push(
          await createDescriptorCandidate({
            config: options.config,
            kind: 'tsconfig',
            ownerDirectory: ownerRootDir,
            path: path.join(directory, name),
            rootDir: directory,
          }),
        );
      }
    }
    const ignoredDirectories = new Set(['.git', '.limina', 'node_modules']);
    for (const [name, stats] of [...names].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (!stats.isDirectory() || ignoredDirectories.has(name)) continue;
      await walk(path.join(directory, name), false);
    }
  };

  await walk(ownerRootDir, true);
  return result;
}

async function assertOutputRootValid(options: {
  activatedPackageRoots: readonly string[];
  config: ResolvedLiminaConfig;
  declaredAt: string;
  outputRoot: string;
}): Promise<LiminaCheckIssue | null> {
  const outputRoot = normalizeAbsolutePath(options.outputRoot);
  const configRoot = normalizeAbsolutePath(options.config.rootDir);
  const namespaceRoot = path.join(configRoot, '.limina');
  const canonicalOutput = await canonicalProjectedPath(outputRoot);
  const canonicalConfig = await canonicalProjectedPath(configRoot);
  const canonicalNamespace = await canonicalProjectedPath(namespaceRoot);
  const canonicalPackages = await Promise.all(
    options.activatedPackageRoots.map(canonicalProjectedPath),
  );
  let reason: string | undefined;

  if (outputRoot === configRoot || isInsideOrEqual(outputRoot, configRoot)) {
    reason = 'The output root equals or contains config.rootDir.';
  } else if (
    canonicalOutput === canonicalConfig ||
    isInsideOrEqual(canonicalOutput, canonicalConfig)
  ) {
    reason = 'The canonical output root equals or contains config.rootDir.';
  } else if (
    options.activatedPackageRoots.some((packageRoot) =>
      isInsideOrEqual(outputRoot, packageRoot),
    ) ||
    canonicalPackages.some((packageRoot) =>
      isInsideOrEqual(canonicalOutput, packageRoot),
    )
  ) {
    reason = 'The output root equals or contains an activated package root.';
  } else if (
    isInsideOrEqual(outputRoot, namespaceRoot) ||
    isInsideOrEqual(namespaceRoot, outputRoot) ||
    isInsideOrEqual(canonicalOutput, canonicalNamespace) ||
    isInsideOrEqual(canonicalNamespace, canonicalOutput)
  ) {
    reason = 'The output root overlaps the trusted .limina namespace.';
  } else {
    try {
      const stats = await lstat(outputRoot);
      if (!stats.isDirectory())
        reason = 'The existing output root is not a directory.';
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      ) {
        throw error;
      }
    }
  }

  return reason
    ? createWorkspaceIssue({
        code: 'LIMINA_WORKSPACE_OUTPUT_ROOT_INVALID',
        config: options.config,
        evidence: [
          `declaration: ${displayPath(configRoot, options.declaredAt)}`,
          `output root: ${displayPath(configRoot, outputRoot)}`,
        ],
        filePath: options.declaredAt,
        fix: 'Choose a dedicated output directory that does not own workspace or Limina roots.',
        reason,
        title: 'Workspace output root is structurally unsafe',
      })
    : null;
}

function createReadableTsconfigCandidate(
  descriptor: WorkspaceDescriptorCandidate,
): ReadableWorkspaceTsconfigCandidate {
  return Object.freeze({
    [readableTsconfigCandidateBrand]: true as const,
    ownerDirectory: descriptor.ownerDirectory,
    path: descriptor.path,
  });
}

export function readWorkspaceTsconfigOutputRoot(
  config: ResolvedLiminaConfig,
  candidate: ReadableWorkspaceTsconfigCandidate,
): WorkspaceTsconfigOutputRootRead {
  if (candidate[readableTsconfigCandidateBrand] !== true) {
    throw new Error('Untrusted workspace tsconfig candidate.');
  }
  let configObject: Record<string, unknown>;
  try {
    configObject = readJsonConfig(config, candidate.path);
  } catch {
    return { kind: 'absent' };
  }
  const liminaOptions = configObject.liminaOptions;
  if (!isPlainRecord(liminaOptions) || !isPlainRecord(liminaOptions.outputs)) {
    return { kind: 'absent' };
  }
  const outDir = liminaOptions.outputs.outDir;
  if (outDir === undefined) {
    return { kind: 'absent' };
  }
  if (typeof outDir !== 'string' || outDir.trim().length === 0) {
    return {
      kind: 'invalid',
      reason: 'liminaOptions.outputs.outDir must be a non-empty relative path.',
    };
  }
  if (path.isAbsolute(outDir)) {
    return {
      kind: 'invalid',
      reason:
        'liminaOptions.outputs.outDir must be relative to its source config.',
    };
  }
  return {
    kind: 'output',
    outputRoot: normalizeAbsolutePath(
      path.resolve(path.dirname(candidate.path), outDir.trim()),
    ),
  };
}

function outsideOutputs(
  descriptors: readonly WorkspaceDescriptorCandidate[],
  outputs: ReadonlySet<string>,
): WorkspaceDescriptorCandidate[] {
  const outputIdentities = [...outputs].map((outputRoot) => ({
    canonicalRoot: canonicalProjectedPathSync(outputRoot),
    lexicalRoot: normalizeAbsolutePath(outputRoot),
  }));

  return descriptors.filter(
    (descriptor) =>
      !outputIdentities.some(
        (output) =>
          isInsideOrEqual(output.lexicalRoot, descriptor.path) ||
          isInsideOrEqual(output.canonicalRoot, descriptor.canonicalPath),
      ),
  );
}

function classifyVisibleDescriptors(options: {
  candidates: readonly WorkspaceDescriptorCandidate[];
  packageBoundaries: readonly PackageScopeRegionBoundary[];
}): WorkspaceDescriptorCandidate[] {
  const visibleBoundaryRoots = options.packageBoundaries
    .filter((boundary) =>
      options.candidates.some(
        (candidate) => candidate.path === boundary.packageJsonPath,
      ),
    )
    .map((boundary) => boundary.rootDir);
  return options.candidates.filter(
    (candidate) =>
      !visibleBoundaryRoots.some(
        (boundaryRoot) =>
          candidate.rootDir !== boundaryRoot &&
          isInsideOrEqual(boundaryRoot, candidate.path),
      ),
  );
}

function fixedPointStateKey(options: {
  candidates: readonly WorkspaceDescriptorCandidate[];
  outputs: ReadonlySet<string>;
}): string {
  return JSON.stringify({
    candidates: options.candidates.map((candidate) => candidate.path).sort(),
    outputs: [...options.outputs].sort(),
  });
}

function resolveStableDescriptors(options: {
  config: ResolvedLiminaConfig;
  explicitOutputs: ReadonlyMap<string, string>;
  packageBoundaries: readonly PackageScopeRegionBoundary[];
  packageOutputs: ReadonlySet<string>;
  universe: readonly WorkspaceDescriptorCandidate[];
}): { candidates: WorkspaceDescriptorCandidate[]; outputs: Set<string> } {
  let candidates = outsideOutputs(options.universe, options.packageOutputs);
  let outputs = new Set(options.packageOutputs);
  const seenStates = new Set<string>();

  while (true) {
    const visible = classifyVisibleDescriptors({
      candidates,
      packageBoundaries: options.packageBoundaries,
    });
    const visibleTsconfigPaths = new Set(
      visible
        .filter((candidate) => candidate.kind === 'tsconfig')
        .map((candidate) => candidate.path),
    );
    const nextOutputs = new Set(options.packageOutputs);
    for (const [producer, outputRoot] of options.explicitOutputs) {
      if (visibleTsconfigPaths.has(producer)) nextOutputs.add(outputRoot);
    }
    const nextCandidates = outsideOutputs(options.universe, nextOutputs);
    const currentKey = fixedPointStateKey({ candidates, outputs });
    const nextKey = fixedPointStateKey({
      candidates: nextCandidates,
      outputs: nextOutputs,
    });
    if (currentKey === nextKey) {
      return {
        candidates: classifyVisibleDescriptors({
          candidates: nextCandidates,
          packageBoundaries: options.packageBoundaries,
        }),
        outputs: nextOutputs,
      };
    }
    if (seenStates.has(nextKey)) {
      throw new LiminaStructuredError(
        'Workspace output set does not stabilize.',
        [
          createWorkspaceIssue({
            code: 'LIMINA_WORKSPACE_OUTPUT_CYCLE',
            config: options.config,
            evidence: [...nextOutputs].map(
              (root) =>
                `output root: ${displayPath(options.config.rootDir, root)}`,
            ),
            filePath: options.config.configPath,
            fix: 'Remove self-output or mutually hiding tsconfig output declarations.',
            reason:
              'Descriptor visibility and tsconfig-declared output roots repeat without reaching a stable state.',
            title: 'Workspace output visibility cycle',
          }),
        ],
      );
    }
    seenStates.add(currentKey);
    candidates = nextCandidates;
    outputs = nextOutputs;
  }
}

function validateCommittedExclusions(options: {
  config: ResolvedLiminaConfig;
  rawPackages: readonly WorkspacePackage[];
  rules: readonly CompiledExclusionRule[];
  stableCandidates: readonly WorkspaceDescriptorCandidate[];
}): void {
  const workspaceCandidates = options.rawPackages.map((workspacePackage) => ({
    kind: 'workspace-package' as const,
    rootDir: workspacePackage.directory,
  }));
  const packageScopeCandidates = options.stableCandidates
    .filter(
      (candidate) =>
        candidate.kind === 'package-json' &&
        normalizeAbsolutePath(candidate.rootDir) !==
          normalizeAbsolutePath(candidate.ownerDirectory),
    )
    .map((candidate) => ({
      kind: 'package-scope' as const,
      rootDir: candidate.rootDir,
    }));
  const candidates = [...workspaceCandidates, ...packageScopeCandidates];
  for (const candidate of candidates) {
    const matches = findExactExclusions({
      config: options.config,
      kind: candidate.kind,
      rootDir: candidate.rootDir,
      rules: [...options.rules],
    });
    if (matches.length > 1) {
      throw new Error(
        `Multiple regions.exclude rules match ${candidate.kind} ${displayPath(options.config.rootDir, candidate.rootDir)}.`,
      );
    }
  }
  const unmatched = options.rules.filter(
    (rule) =>
      !candidates.some(
        (candidate) =>
          candidate.kind === rule.entry.kind &&
          rule.matchers.some((matches) =>
            matches(displayPath(options.config.rootDir, candidate.rootDir)),
          ),
      ),
  );
  if (unmatched.length === 0) return;
  throw new Error(
    `regions.exclude[${unmatched[0]!.index}] does not match an exact governance candidate.`,
  );
}

export async function collectValidatedWorkspaceContext(options: {
  config: ResolvedLiminaConfig;
  rawPackages: readonly WorkspacePackage[];
}): Promise<ValidatedWorkspaceContext> {
  const { config } = options;
  const overlapIssues = await collectSameRootOverlapIssues(options);
  if (overlapIssues.length > 0) {
    throw new LiminaStructuredError(
      'Workspace validation failed.',
      overlapIssues,
    );
  }

  const rules = compileExclusionRules(config);
  const packages = applyWorkspacePackageExclusions({
    config,
    rawPackages: options.rawPackages,
    rules,
  });
  const identityResult = await collectPackageIdentities({
    config,
    rawPackages: packages,
  });
  if (identityResult.issues.length > 0) {
    throw new LiminaStructuredError(
      'Workspace validation failed.',
      identityResult.issues,
    );
  }
  const islands = await Promise.all(
    packages.map((owner) =>
      collectPackageIsland({
        activatedIdentities: identityResult.identities.filter((identity) =>
          packages.includes(identity.package),
        ),
        activatedPackages: packages,
        config,
        owner,
        rules,
      }),
    ),
  );
  const universe = islands.flatMap((island) => island.descriptors);
  const packageBoundaries = islands.flatMap((island) => island.boundaries);
  const activatedPackageRoots = packages.map((workspacePackage) =>
    normalizeAbsolutePath(workspacePackage.directory),
  );
  const packageOutputs = new Set<string>();
  const outputIssues: LiminaCheckIssue[] = [];

  for (const [entryIndex, entry] of (config.package?.entries ?? []).entries()) {
    if (path.isAbsolute(entry.outDir)) {
      outputIssues.push({
        ...createWorkspaceIssue({
          code: 'LIMINA_WORKSPACE_OUTPUT_ROOT_INVALID',
          config,
          evidence: [`declaration: package.entries[${entryIndex}].outDir`],
          filePath: config.configPath,
          fix: 'Use a config.rootDir-relative package output path.',
          reason:
            'package.entries[].outDir must be relative to config.rootDir.',
          title: 'Workspace output root is structurally unsafe',
        }),
        detailLines: [`package.entries[${entryIndex}].outDir`],
      });
      continue;
    }
    const outputRoot = normalizeAbsolutePath(
      path.resolve(config.rootDir, entry.outDir),
    );
    const issue = await assertOutputRootValid({
      activatedPackageRoots,
      config,
      declaredAt: config.configPath,
      outputRoot,
    });
    if (issue) {
      outputIssues.push({
        ...issue,
        detailLines: [`package.entries[${entryIndex}].outDir`],
      });
    } else {
      packageOutputs.add(outputRoot);
    }
  }
  if (outputIssues.length > 0) {
    throw new LiminaStructuredError(
      'Workspace output validation failed.',
      outputIssues,
    );
  }

  const initialCandidates = outsideOutputs(universe, packageOutputs);
  const readableTsconfigs = initialCandidates
    .filter((descriptor) => descriptor.kind === 'tsconfig')
    .map(createReadableTsconfigCandidate);
  const explicitOutputs = new Map<string, string>();
  for (const candidate of readableTsconfigs) {
    const output = readWorkspaceTsconfigOutputRoot(config, candidate);
    if (output.kind === 'absent') continue;
    if (output.kind === 'invalid') {
      outputIssues.push(
        createWorkspaceIssue({
          code: 'LIMINA_WORKSPACE_OUTPUT_ROOT_INVALID',
          config,
          evidence: [
            `declaration: ${displayPath(config.rootDir, candidate.path)}`,
          ],
          filePath: candidate.path,
          fix: 'Use a non-empty source-config-relative output path.',
          reason: output.reason,
          title: 'Workspace output root is structurally unsafe',
        }),
      );
      continue;
    }
    const outputRoot = output.outputRoot;
    const issue = await assertOutputRootValid({
      activatedPackageRoots,
      config,
      declaredAt: candidate.path,
      outputRoot,
    });
    if (issue) outputIssues.push(issue);
    else explicitOutputs.set(candidate.path, outputRoot);
  }
  if (outputIssues.length > 0) {
    throw new LiminaStructuredError(
      'Workspace output validation failed.',
      outputIssues,
    );
  }

  const stable = resolveStableDescriptors({
    config,
    explicitOutputs,
    packageBoundaries,
    packageOutputs,
    universe,
  });
  validateCommittedExclusions({
    config,
    rawPackages: options.rawPackages,
    rules,
    stableCandidates: stable.candidates,
  });
  const stablePaths = new Set(
    stable.candidates.map((candidate) => candidate.path),
  );
  const boundaries: WorkspaceRegionBoundary[] = [
    ...islands
      .flatMap((island) => island.pnpmBoundaries)
      .filter((boundary) => stablePaths.has(boundary.workspaceYamlPath)),
    ...packageBoundaries.filter((boundary) =>
      stablePaths.has(boundary.packageJsonPath),
    ),
  ];
  const packageIdentities = identityResult.identities.filter((identity) =>
    packages.includes(identity.package),
  );

  return {
    boundaries,
    configRootDir: normalizeAbsolutePath(config.rootDir),
    descriptorCandidates: stable.candidates,
    extendedPackageScopes: islands
      .flatMap((island) => island.extendedScopes)
      .filter((scope) => stablePaths.has(scope.packageJsonPath)),
    outputRoots: [...stable.outputs].sort(),
    packageIdentities,
    packages,
    rawPackages: [...options.rawPackages],
    sourceConfigPaths: stable.candidates
      .filter((candidate) => candidate.kind === 'tsconfig')
      .map((candidate) => candidate.path)
      .sort(),
    workspaceRootDir: findNearestPnpmWorkspaceRoot(config.rootDir),
  };
}

export class WorkspaceRegionPathIndex {
  readonly packages: readonly WorkspacePackage[];
  readonly rootDir: string;
  readonly #boundariesByOwner: Map<
    string,
    { boundary: WorkspaceRegionBoundary; canonicalRootDir: string }[]
  >;
  readonly #boundaryByPath = new Map<string, WorkspaceRegionBoundary | null>();
  readonly #canonicalProjectedPathByNormalizedPath = new Map<string, string>();
  readonly #identities: WorkspacePackageIdentity[];
  readonly #metrics: WorkspaceIndexMetricsRecorder | undefined;
  readonly #packageByPath = new Map<string, WorkspacePackage | null>();
  readonly #sourceConfigIdentities: Set<string>;

  constructor(
    context: ValidatedWorkspaceContext,
    metrics?: WorkspaceIndexMetricsRecorder,
  ) {
    this.#metrics = metrics;
    this.packages = context.packages.map((workspacePackage) => ({
      ...workspacePackage,
      manifest: { ...workspacePackage.manifest },
    }));
    this.rootDir = normalizeAbsolutePath(context.configRootDir);
    this.#identities = [...context.packageIdentities].sort(
      (left, right) =>
        right.canonicalDirectory.length - left.canonicalDirectory.length,
    );
    this.#boundariesByOwner = new Map();
    this.#sourceConfigIdentities = new Set(
      context.sourceConfigPaths.map((sourceConfigPath) =>
        this.#canonicalProjectedPath(sourceConfigPath),
      ),
    );
    for (const identity of this.#identities) {
      this.#boundariesByOwner.set(
        identity.canonicalDirectory,
        context.boundaries
          .filter((boundary) =>
            isInsideOrEqual(identity.package.directory, boundary.rootDir),
          )
          .map((boundary) => ({
            boundary,
            canonicalRootDir: this.#canonicalProjectedPath(boundary.rootDir),
          })),
      );
    }
  }

  findPackageForPath(filePath: string): WorkspacePackage | null {
    const normalizedFilePath = normalizeAbsolutePath(filePath);
    if (this.#packageByPath.has(normalizedFilePath)) {
      const cached = this.#packageByPath.get(normalizedFilePath) ?? null;
      this.#recordLookup('hit', 'region-package', cached);
      return cached;
    }

    const canonicalPath = this.#canonicalProjectedPath(normalizedFilePath);
    const identity = this.#identities.find((candidate) =>
      isInsideOrEqual(candidate.canonicalDirectory, canonicalPath),
    );
    if (!identity) {
      this.#packageByPath.set(normalizedFilePath, null);
      this.#recordLookup('miss', 'region-package', null);
      return null;
    }
    const boundaries =
      this.#boundariesByOwner.get(identity.canonicalDirectory) ?? [];
    const workspacePackage = boundaries.some(({ canonicalRootDir }) =>
      isInsideOrEqual(canonicalRootDir, canonicalPath),
    )
      ? null
      : identity.package;
    this.#packageByPath.set(normalizedFilePath, workspacePackage);
    this.#recordLookup('miss', 'region-package', workspacePackage);
    return workspacePackage;
  }

  findBoundaryForPath(filePath: string): WorkspaceRegionBoundary | null {
    const normalizedFilePath = normalizeAbsolutePath(filePath);
    if (this.#boundaryByPath.has(normalizedFilePath)) {
      const cached = this.#boundaryByPath.get(normalizedFilePath) ?? null;
      this.#recordLookup('hit', 'region-boundary', cached);
      return cached;
    }

    const canonicalPath = this.#canonicalProjectedPath(normalizedFilePath);
    const identity = this.#identities.find((candidate) =>
      isInsideOrEqual(candidate.canonicalDirectory, canonicalPath),
    );
    const boundary = identity
      ? ((this.#boundariesByOwner.get(identity.canonicalDirectory) ?? [])
          .filter(({ canonicalRootDir }) =>
            isInsideOrEqual(canonicalRootDir, canonicalPath),
          )
          .sort(
            (left, right) =>
              right.canonicalRootDir.length - left.canonicalRootDir.length,
          )[0]?.boundary ?? null)
      : null;
    this.#boundaryByPath.set(normalizedFilePath, boundary);
    this.#recordLookup('miss', 'region-boundary', boundary);
    return boundary;
  }

  #canonicalProjectedPath(targetPath: string): string {
    const normalizedTarget = normalizeAbsolutePath(targetPath);
    const cached =
      this.#canonicalProjectedPathByNormalizedPath.get(normalizedTarget);
    if (cached !== undefined) {
      this.#metrics?.record({
        kind: 'projected-path',
        name: 'canonical-path-cache-hit',
        provider: 'workspace-path-index',
      });
      return cached;
    }

    this.#metrics?.record({
      kind: 'projected-path',
      name: 'canonical-path-cache-miss',
      provider: 'workspace-path-index',
    });
    const canonicalPath = canonicalProjectedPathSync(normalizedTarget);
    this.#metrics?.record({
      kind: 'projected-path',
      name: 'canonical-path',
      provider: 'workspace-path-index',
    });
    this.#canonicalProjectedPathByNormalizedPath.set(
      normalizedTarget,
      canonicalPath,
    );
    return canonicalPath;
  }

  #recordLookup(state: 'hit' | 'miss', kind: string, value: unknown): void {
    this.#metrics?.record({
      kind,
      name: state === 'hit' ? 'provider-cache-hit' : 'provider-cache-miss',
      provider: 'workspace-path-index',
    });
    if (value === null) {
      this.#metrics?.record({
        kind,
        name: 'workspace-negative-lookup',
        provider: 'workspace-path-index',
      });
    }
  }

  isInsideActivatedRegion(filePath: string): boolean {
    return Boolean(this.findPackageForPath(filePath));
  }

  isSourceConfigPath(filePath: string): boolean {
    return (
      this.isInsideActivatedRegion(filePath) &&
      this.#sourceConfigIdentities.has(this.#canonicalProjectedPath(filePath))
    );
  }
}

function canonicalProjectedPathSync(targetPath: string): string {
  const normalizedTarget = normalizeAbsolutePath(targetPath);
  let cursor = normalizedTarget;
  const suffix: string[] = [];
  while (true) {
    try {
      return normalizeAbsolutePath(
        path.join(realpathSync.native(cursor), ...suffix.toReversed()),
      );
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      ) {
        throw error;
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return normalizedTarget;
    suffix.push(path.basename(cursor));
    cursor = parent;
  }
}
