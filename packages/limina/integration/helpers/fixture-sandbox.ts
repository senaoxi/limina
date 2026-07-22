import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import picomatch from 'picomatch';

import {
  isPathInsideDirectory,
  normalizeAbsolutePathIdentity,
} from '../../src/utils/path';
import type {
  FixtureCopyPolicy,
  FixtureMutation,
  FixtureSetupOperation,
} from './detector-fixture-types';
import {
  isPortablePathAtOrBelow,
  resolvePortablePathInside,
  validatePortableRelativePath,
} from './fixture-paths';

export const PRESERVE_INTEGRATION_ARTIFACTS_ENV =
  'LIMINA_PRESERVE_INTEGRATION_ARTIFACTS';
export const SANDBOX_CLEANUP_MAX_RETRIES = 5;
export const SANDBOX_CLEANUP_RETRY_DELAY_MS = 100;
export const PERMANENT_COPY_EXCLUDED_NAMES = [
  '.limina',
  'coverage',
  'node_modules',
] as const;
export const DEFAULT_SANDBOX_IGNORED_PATH_PREFIXES = [
  'cache',
  'harness',
  'home',
  'repo/.limina',
  'repo/node_modules',
  'tmp',
] as const;

const PERMANENT_COPY_EXCLUDED_NAME_SET = new Set<string>(
  PERMANENT_COPY_EXCLUDED_NAMES,
);
const PROTECTED_MUTATION_ROOTS = ['repo/.limina', 'repo/node_modules'];

export interface DetectorSandbox {
  readonly repoRoot: string;
  readonly sandboxRoot: string;
  readonly tempRoot: string;
}

export interface TreeEntrySnapshot {
  readonly hash?: string;
  readonly kind: 'directory' | 'file' | 'link';
  readonly target?: string;
}

export type TreeSnapshot = ReadonlyMap<string, TreeEntrySnapshot>;

interface RemoveSandboxDependencies {
  readonly remove: typeof rm;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPathError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

export async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await lstat(candidatePath);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

async function assertRealDirectory(directoryPath: string, label: string) {
  const directoryStat = await lstat(directoryPath);

  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${directoryPath}`);
  }

  return directoryStat;
}

async function assertSafeExistingAncestors(options: {
  readonly candidatePath: string;
  readonly includeCandidate: boolean;
  readonly rootDir: string;
}): Promise<void> {
  await assertRealDirectory(options.rootDir, 'Sandbox root');
  const canonicalRoot = normalizeAbsolutePathIdentity(
    await realpath(options.rootDir),
  );
  if (!isPathInsideDirectory(options.candidatePath, options.rootDir)) {
    throw new Error(
      `Sandbox path escapes its lexical root: ${options.candidatePath}`,
    );
  }

  const relativePath = path.relative(options.rootDir, options.candidatePath);
  const segments = relativePath ? relativePath.split(path.sep) : [];
  const inspectedSegments = options.includeCandidate
    ? segments
    : segments.slice(0, -1);
  let currentPath = options.rootDir;

  for (const [index, segment] of inspectedSegments.entries()) {
    currentPath = path.join(currentPath, segment);
    let currentStat;
    try {
      currentStat = await lstat(currentPath);
    } catch (error) {
      if (isMissingPathError(error)) {
        return;
      }
      throw error;
    }

    if (currentStat.isSymbolicLink()) {
      throw new Error(`Sandbox path traverses a link: ${currentPath}`);
    }
    if (index < inspectedSegments.length - 1 && !currentStat.isDirectory()) {
      throw new Error(`Sandbox path traverses a non-directory: ${currentPath}`);
    }

    const canonicalCurrent = normalizeAbsolutePathIdentity(
      await realpath(currentPath),
    );
    if (!isPathInsideDirectory(canonicalCurrent, canonicalRoot)) {
      throw new Error(
        `Sandbox path escapes its canonical root: ${currentPath}`,
      );
    }
  }
}

function assertMutableSandboxPath(relativePath: string): void {
  if (relativePath === 'repo') {
    throw new Error(
      'Fixture operations must not replace or remove the repo root.',
    );
  }
  const protectedRoot = PROTECTED_MUTATION_ROOTS.find((candidate) =>
    isPortablePathAtOrBelow(relativePath, candidate),
  );
  if (protectedRoot) {
    throw new Error(
      `Fixture operations must not modify harness-managed path ${protectedRoot}: ${relativePath}`,
    );
  }
}

async function prepareSafeParent(
  sandboxRoot: string,
  candidatePath: string,
): Promise<void> {
  await assertSafeExistingAncestors({
    candidatePath,
    includeCandidate: false,
    rootDir: sandboxRoot,
  });
  await mkdir(path.dirname(candidatePath), { recursive: true });
  await assertSafeExistingAncestors({
    candidatePath,
    includeCandidate: false,
    rootDir: sandboxRoot,
  });
}

async function writeSandboxFile(options: {
  readonly content: string;
  readonly overwrite: boolean;
  readonly relativePath: string;
  readonly sandboxRoot: string;
}): Promise<void> {
  assertMutableSandboxPath(options.relativePath);
  const destinationPath = resolvePortablePathInside(
    options.sandboxRoot,
    options.relativePath,
    'fixture write-file path',
  );
  await prepareSafeParent(options.sandboxRoot, destinationPath);

  if (await pathExists(destinationPath)) {
    const destinationStat = await lstat(destinationPath);
    if (destinationStat.isSymbolicLink()) {
      throw new Error(
        `Fixture write-file refuses to follow a link: ${options.relativePath}`,
      );
    }
    if (!destinationStat.isFile()) {
      throw new Error(
        `Fixture write-file target is not a file: ${options.relativePath}`,
      );
    }
    if (!options.overwrite) {
      throw new Error(
        `Fixture write-file target already exists: ${options.relativePath}`,
      );
    }
  }

  await writeFile(destinationPath, options.content, {
    encoding: 'utf8',
    flag: options.overwrite ? 'w' : 'wx',
  });
}

async function removeSandboxPath(options: {
  readonly allowMissing: boolean;
  readonly relativePath: string;
  readonly sandboxRoot: string;
}): Promise<void> {
  assertMutableSandboxPath(options.relativePath);
  const destinationPath = resolvePortablePathInside(
    options.sandboxRoot,
    options.relativePath,
    'fixture remove-path path',
  );
  await assertSafeExistingAncestors({
    candidatePath: destinationPath,
    includeCandidate: false,
    rootDir: options.sandboxRoot,
  });

  if (!(await pathExists(destinationPath))) {
    if (options.allowMissing) {
      return;
    }
    throw new Error(
      `Fixture remove-path target is missing: ${options.relativePath}`,
    );
  }

  await rm(destinationPath, { force: false, recursive: true });
}

async function createSandboxDirectoryLink(options: {
  readonly linkPath: string;
  readonly sandboxRoot: string;
  readonly targetPath: string;
}): Promise<void> {
  assertMutableSandboxPath(options.linkPath);
  const linkPath = resolvePortablePathInside(
    options.sandboxRoot,
    options.linkPath,
    'fixture directory-link path',
  );
  const targetPath = resolvePortablePathInside(
    options.sandboxRoot,
    options.targetPath,
    'fixture directory-link target',
  );
  await assertSafeExistingAncestors({
    candidatePath: targetPath,
    includeCandidate: true,
    rootDir: options.sandboxRoot,
  });
  const targetStat = await lstat(targetPath);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw new Error(
      `Fixture directory-link target must be a real directory: ${options.targetPath}`,
    );
  }
  if (await pathExists(linkPath)) {
    throw new Error(
      `Fixture directory-link path already exists: ${options.linkPath}`,
    );
  }
  await prepareSafeParent(options.sandboxRoot, linkPath);

  const linkTarget =
    process.platform === 'win32'
      ? path.resolve(targetPath)
      : path.relative(path.dirname(linkPath), targetPath);
  await symlink(
    linkTarget,
    linkPath,
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  const [canonicalLink, canonicalTarget] = await Promise.all([
    realpath(linkPath),
    realpath(targetPath),
  ]);
  if (
    normalizeAbsolutePathIdentity(canonicalLink) !==
    normalizeAbsolutePathIdentity(canonicalTarget)
  ) {
    throw new Error(
      `Fixture directory-link canonical target mismatch: ${options.linkPath}`,
    );
  }
}

export async function applyFixtureSetup(options: {
  readonly fixtureId: string;
  readonly operations: readonly FixtureSetupOperation[];
  readonly sandboxRoot: string;
}): Promise<void> {
  for (const [index, operation] of options.operations.entries()) {
    try {
      if (operation.kind === 'write-file') {
        await writeSandboxFile({
          content: operation.content,
          overwrite: operation.overwrite ?? false,
          relativePath: operation.path,
          sandboxRoot: options.sandboxRoot,
        });
      } else if (operation.kind === 'remove-path') {
        await removeSandboxPath({
          allowMissing: operation.allowMissing ?? false,
          relativePath: operation.path,
          sandboxRoot: options.sandboxRoot,
        });
      } else {
        await createSandboxDirectoryLink({
          linkPath: operation.path,
          sandboxRoot: options.sandboxRoot,
          targetPath: operation.target,
        });
      }
    } catch (error) {
      throw new Error(
        `Detector fixture ${options.fixtureId} setup operation ${index} (${operation.kind}) failed: ${formatUnknownError(error)}`,
        { cause: error },
      );
    }
  }
}

async function replaceSandboxText(options: {
  readonly all: boolean;
  readonly relativePath: string;
  readonly replacement: string;
  readonly sandboxRoot: string;
  readonly search: string;
}): Promise<void> {
  assertMutableSandboxPath(options.relativePath);
  const targetPath = resolvePortablePathInside(
    options.sandboxRoot,
    options.relativePath,
    'fixture replace-text path',
  );
  await assertSafeExistingAncestors({
    candidatePath: targetPath,
    includeCandidate: true,
    rootDir: options.sandboxRoot,
  });
  const targetStat = await lstat(targetPath);
  if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
    throw new Error(
      `Fixture replace-text target must be a real file: ${options.relativePath}`,
    );
  }
  const current = await readFile(targetPath, 'utf8');
  const matches = current.split(options.search).length - 1;
  if (matches === 0) {
    throw new Error(
      `Fixture replace-text search was not found: ${options.relativePath}`,
    );
  }
  if (!options.all && matches !== 1) {
    throw new Error(
      `Fixture replace-text expected one match but found ${matches}: ${options.relativePath}`,
    );
  }
  const next = options.all
    ? current.replaceAll(options.search, options.replacement)
    : current.replace(options.search, options.replacement);
  await writeFile(targetPath, next, 'utf8');
}

export async function applyFixtureMutations(options: {
  readonly fixtureId: string;
  readonly mutations: readonly FixtureMutation[];
  readonly sandboxRoot: string;
}): Promise<void> {
  for (const [index, mutation] of options.mutations.entries()) {
    try {
      if (mutation.kind === 'write-file') {
        await writeSandboxFile({
          content: mutation.content,
          overwrite: mutation.overwrite ?? true,
          relativePath: mutation.path,
          sandboxRoot: options.sandboxRoot,
        });
      } else if (mutation.kind === 'remove-path') {
        await removeSandboxPath({
          allowMissing: mutation.allowMissing ?? false,
          relativePath: mutation.path,
          sandboxRoot: options.sandboxRoot,
        });
      } else {
        await replaceSandboxText({
          all: mutation.all ?? false,
          relativePath: mutation.path,
          replacement: mutation.replacement,
          sandboxRoot: options.sandboxRoot,
          search: mutation.search,
        });
      }
    } catch (error) {
      throw new Error(
        `Detector fixture ${options.fixtureId} mutation ${index} (${mutation.kind}) failed: ${formatUnknownError(error)}`,
        { cause: error },
      );
    }
  }
}

function isCopyEntryExcluded(
  entryName: string,
  policy: FixtureCopyPolicy,
): boolean {
  if (PERMANENT_COPY_EXCLUDED_NAME_SET.has(entryName)) {
    return true;
  }
  if (!policy.includeBuildInfoFiles && entryName.endsWith('.tsbuildinfo')) {
    return true;
  }
  if (!policy.includeOutputDirectories && entryName === 'dist') {
    return true;
  }

  return new Set(policy.excludedNames).has(entryName);
}

class FixtureCopyError extends Error {}

async function copyFixtureEntry(options: {
  readonly destinationPath: string;
  readonly policy: FixtureCopyPolicy;
  readonly sourcePath: string;
  readonly sourceRoot: string;
}): Promise<void> {
  try {
    if (!isPathInsideDirectory(options.sourcePath, options.sourceRoot)) {
      throw new Error('source traversal escaped the fixture root');
    }
    const sourceStat = await lstat(options.sourcePath);
    if (sourceStat.isSymbolicLink()) {
      throw new Error('fixture source links are not supported');
    }

    const canonicalSource = await realpath(options.sourcePath);
    if (!isPathInsideDirectory(canonicalSource, options.sourceRoot)) {
      throw new Error('canonical source traversal escaped the fixture root');
    }

    if (sourceStat.isDirectory()) {
      await mkdir(options.destinationPath, { recursive: true });
      const entries = (await readdir(options.sourcePath)).sort();
      for (const entryName of entries) {
        if (isCopyEntryExcluded(entryName, options.policy)) {
          continue;
        }
        await copyFixtureEntry({
          destinationPath: path.join(options.destinationPath, entryName),
          policy: options.policy,
          sourcePath: path.join(options.sourcePath, entryName),
          sourceRoot: options.sourceRoot,
        });
      }
      return;
    }
    if (!sourceStat.isFile()) {
      throw new Error('fixture source entry is neither a file nor a directory');
    }

    await mkdir(path.dirname(options.destinationPath), { recursive: true });
    await copyFile(options.sourcePath, options.destinationPath);
    await chmod(options.destinationPath, sourceStat.mode);
  } catch (error) {
    if (error instanceof FixtureCopyError) {
      throw error;
    }
    throw new FixtureCopyError(
      `Unable to copy detector fixture entry from ${options.sourcePath} to ${options.destinationPath}: ${formatUnknownError(error)}`,
      { cause: error },
    );
  }
}

export async function copyFixtureRepository(options: {
  readonly destinationRoot: string;
  readonly policy?: FixtureCopyPolicy;
  readonly sourceRoot: string;
}): Promise<void> {
  await assertRealDirectory(options.sourceRoot, 'Detector fixture source');
  const canonicalSourceRoot = await realpath(options.sourceRoot);
  if (await pathExists(options.destinationRoot)) {
    throw new Error(
      `Detector fixture copy destination already exists: ${options.destinationRoot}`,
    );
  }

  await copyFixtureEntry({
    destinationPath: options.destinationRoot,
    policy: {
      excludedNames: options.policy?.excludedNames ?? [],
      includeBuildInfoFiles: options.policy?.includeBuildInfoFiles ?? false,
      includeOutputDirectories:
        options.policy?.includeOutputDirectories ?? false,
    },
    sourcePath: canonicalSourceRoot,
    sourceRoot: canonicalSourceRoot,
  });
}

function isIgnoredSnapshotPath(
  relativePath: string,
  ignoredPrefixes: readonly string[],
): boolean {
  return ignoredPrefixes.some((prefix) =>
    isPortablePathAtOrBelow(relativePath, prefix),
  );
}

export async function captureTreeSnapshot(options: {
  readonly ignoredPathPrefixes?: readonly string[];
  readonly rootDir: string;
}): Promise<TreeSnapshot> {
  const rootDir = await realpath(options.rootDir);
  await assertRealDirectory(rootDir, 'Tree snapshot root');
  const ignoredPrefixes = options.ignoredPathPrefixes ?? [];
  const snapshot = new Map<string, TreeEntrySnapshot>();

  async function visit(directoryPath: string, relativeDirectory: string) {
    const entries = (await readdir(directoryPath)).sort();
    for (const entryName of entries) {
      const absolutePath = path.join(directoryPath, entryName);
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entryName}`
        : entryName;
      if (isIgnoredSnapshotPath(relativePath, ignoredPrefixes)) {
        continue;
      }
      const entryStat = await lstat(absolutePath);

      if (entryStat.isSymbolicLink()) {
        const targetStat = await stat(absolutePath);
        if (!targetStat.isDirectory()) {
          throw new Error(
            `Tree snapshot encountered an unsupported file link: ${absolutePath}`,
          );
        }
        const canonicalTarget = normalizeAbsolutePathIdentity(
          await realpath(absolutePath),
        );
        if (!isPathInsideDirectory(canonicalTarget, rootDir)) {
          throw new Error(
            `Tree snapshot directory link escapes its root: ${absolutePath}`,
          );
        }
        snapshot.set(relativePath, {
          kind: 'link',
          target: canonicalTarget,
        });
        continue;
      }
      if (entryStat.isDirectory()) {
        snapshot.set(relativePath, { kind: 'directory' });
        await visit(absolutePath, relativePath);
        continue;
      }
      if (entryStat.isFile()) {
        snapshot.set(relativePath, {
          hash: createHash('sha256')
            .update(await readFile(absolutePath))
            .digest('hex'),
          kind: 'file',
        });
        continue;
      }
      throw new Error(
        `Tree snapshot encountered an unsupported entry: ${absolutePath}`,
      );
    }
  }

  await visit(rootDir, '');
  return snapshot;
}

function isAllowedAddedPath(
  relativePath: string,
  patterns: readonly string[],
  matcher: (value: string) => boolean,
): boolean {
  if (matcher(relativePath)) {
    return true;
  }

  return patterns.some((pattern) => {
    const firstGlobIndex = pattern.search(/[*?[\]{}()!]/u);
    const literalPrefix =
      firstGlobIndex === -1 ? pattern : pattern.slice(0, firstGlobIndex);
    return literalPrefix.startsWith(`${relativePath}/`);
  });
}

export function assertTreeSnapshotUnchanged(options: {
  readonly after: TreeSnapshot;
  readonly allowedAddedPaths?: readonly string[];
  readonly before: TreeSnapshot;
  readonly label: string;
}): void {
  const patterns = options.allowedAddedPaths ?? [];
  const matcher = picomatch([...patterns], { dot: true });
  const differences: string[] = [];

  for (const [relativePath, beforeEntry] of options.before) {
    const afterEntry = options.after.get(relativePath);
    if (!afterEntry) {
      differences.push(`deleted ${relativePath}`);
    } else if (JSON.stringify(afterEntry) !== JSON.stringify(beforeEntry)) {
      differences.push(`modified ${relativePath}`);
    }
  }
  for (const relativePath of options.after.keys()) {
    if (
      !options.before.has(relativePath) &&
      !isAllowedAddedPath(relativePath, patterns, matcher)
    ) {
      differences.push(`added ${relativePath}`);
    }
  }

  if (differences.length > 0) {
    const visible = differences.slice(0, 20);
    const omitted = differences.length - visible.length;
    throw new Error(
      [
        `${options.label} changed unexpectedly:`,
        ...visible.map((difference) => `- ${difference}`),
        ...(omitted > 0 ? [`- ... ${omitted} more changes omitted`] : []),
      ].join('\n'),
    );
  }
}

export async function createDetectorSandbox(options: {
  readonly fixtureId: string;
  readonly tempRoot?: string;
}): Promise<DetectorSandbox> {
  const platformTempRoot =
    process.platform === 'win32' ? tmpdir() : `${path.parse(tmpdir()).root}tmp`;
  const requestedTempRoot =
    options.tempRoot ??
    path.join(platformTempRoot, `ldi-${String(process.getuid?.() ?? 'user')}`);
  await mkdir(requestedTempRoot, { recursive: true });
  await assertRealDirectory(
    requestedTempRoot,
    'Detector integration temp root',
  );
  const tempRoot = await realpath(requestedTempRoot);
  await assertRealDirectory(tempRoot, 'Detector integration temp root');
  const readableName = options.fixtureId.replaceAll('/', '-');
  const stableName =
    readableName.length <= 24
      ? readableName
      : `${readableName.slice(0, 15)}-${createHash('sha256')
          .update(options.fixtureId)
          .digest('hex')
          .slice(0, 8)}`;
  const sandboxRoot = await realpath(
    await mkdtemp(path.join(tempRoot, `detector-${stableName}-`)),
  );

  return {
    repoRoot: path.join(sandboxRoot, 'repo'),
    sandboxRoot,
    tempRoot,
  };
}

export async function cleanupDetectorSandbox(
  options: {
    readonly preserve?: boolean;
    readonly sandboxRoot: string;
    readonly tempRoot: string;
  },
  dependencies: RemoveSandboxDependencies = { remove: rm },
): Promise<boolean> {
  const tempRoot = normalizeAbsolutePathIdentity(
    await realpath(options.tempRoot),
  );
  const sandboxRoot = normalizeAbsolutePathIdentity(options.sandboxRoot);
  if (
    sandboxRoot === tempRoot ||
    !isPathInsideDirectory(sandboxRoot, tempRoot)
  ) {
    throw new Error(
      `Refusing to clean detector sandbox outside the integration temp root: ${sandboxRoot}`,
    );
  }
  await assertRealDirectory(sandboxRoot, 'Detector sandbox cleanup target');
  const canonicalSandbox = normalizeAbsolutePathIdentity(
    await realpath(sandboxRoot),
  );
  if (!isPathInsideDirectory(canonicalSandbox, tempRoot)) {
    throw new Error(
      `Refusing to clean detector sandbox outside the canonical integration temp root: ${canonicalSandbox}`,
    );
  }

  const preserve =
    options.preserve ?? process.env[PRESERVE_INTEGRATION_ARTIFACTS_ENV] === '1';
  if (preserve) {
    return false;
  }

  await dependencies.remove(canonicalSandbox, {
    force: true,
    maxRetries: SANDBOX_CLEANUP_MAX_RETRIES,
    recursive: true,
    retryDelay: SANDBOX_CLEANUP_RETRY_DELAY_MS,
  });
  return true;
}

export async function finishFixtureCleanup(options: {
  readonly cleanup: () => Promise<unknown>;
  readonly primaryError?: unknown;
}): Promise<void> {
  let cleanupError: unknown;
  try {
    await options.cleanup();
  } catch (error) {
    cleanupError = error;
  }

  if (options.primaryError !== undefined && cleanupError !== undefined) {
    throw new Error(
      `${formatUnknownError(options.primaryError)}\nCleanup failure: ${formatUnknownError(cleanupError)}`,
      { cause: options.primaryError },
    );
  }
  if (options.primaryError !== undefined) {
    throw options.primaryError;
  }
  if (cleanupError !== undefined) {
    throw cleanupError;
  }
}

export function validateGeneratedPathPatterns(
  patterns: readonly string[],
): readonly string[] {
  for (const [index, pattern] of patterns.entries()) {
    validatePortableRelativePath(pattern, {
      allowGlob: true,
      label: `allowedGeneratedPaths[${index}]`,
    });
  }
  return patterns;
}
