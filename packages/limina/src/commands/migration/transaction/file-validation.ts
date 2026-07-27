import { isPathInsideDirectory, normalizeAbsolutePath } from '#utils/path';
import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'pathe';
import {
  ReplacementDriftError,
  TerminalReplacementValidationError,
} from '../../../check-reporting/atomic-writer';
import {
  assertContentMatches,
  assertEqual,
  assertStatMatches,
  createPreparedIdentity,
  normalizeStat,
  validationIo,
} from './file-stat';
import type {
  MigrationWritePlanItem,
  ModifiedTargetSnapshot,
  OriginalTargetValidationOptions,
  PreparedFileIdentity,
  StatComparisonOptions,
} from './types';

export async function assertWritable(options: {
  filePath: string;
  openFile: OriginalTargetValidationOptions['openFile'];
}): Promise<void> {
  const handle = await validationIo(
    `Unable to open ${options.filePath} for writing`,
    () => options.openFile(options.filePath, 'r+'),
  );
  await validationIo(
    `Unable to close writable handle for ${options.filePath}`,
    () => handle.close(),
  );
}

function isOutsideLogicalRoot(relativePath: string): boolean {
  return [
    relativePath === '..',
    relativePath.startsWith(`..${path.sep}`),
    path.isAbsolute(relativePath),
  ].some(Boolean);
}

function getLogicalSegments(rootDir: string, targetPath: string): string[] {
  const relativePath = path.relative(rootDir, targetPath);
  if (isOutsideLogicalRoot(relativePath)) {
    throw new TerminalReplacementValidationError(
      `Migration target is outside the logical workspace root: ${targetPath}`,
    );
  }
  return relativePath.split(/[\\/]/u).filter(Boolean);
}

export async function assertLogicalPathHasNoLinks(
  rootDir: string,
  targetPath: string,
): Promise<void> {
  let currentPath = rootDir;
  for (const segment of getLogicalSegments(rootDir, targetPath)) {
    const inspectedPath = path.join(currentPath, segment);
    currentPath = inspectedPath;
    const currentStat = normalizeStat(
      await validationIo(`Unable to inspect ${inspectedPath}`, () =>
        lstat(inspectedPath, { bigint: true }),
      ),
    );
    if (currentStat.fileType === 'symlink') {
      throw new TerminalReplacementValidationError(
        `Migration target path contains a symbolic link or junction: ${inspectedPath}`,
      );
    }
  }
}

async function resolveCanonicalTarget(options: {
  canonicalRootDir: string;
  configPath: string;
  rootDir: string;
}): Promise<string> {
  await assertLogicalPathHasNoLinks(options.rootDir, options.configPath);
  const canonicalPath = await validationIo(
    `Unable to resolve canonical target ${options.configPath}`,
    () => realpath(options.configPath),
  );
  if (!isPathInsideDirectory(canonicalPath, options.canonicalRootDir)) {
    throw new TerminalReplacementValidationError(
      `Migration target resolves outside the canonical workspace root: ${options.configPath} -> ${canonicalPath}`,
    );
  }
  return canonicalPath;
}

function isRegularTargetPair(fileTypes: readonly string[]): boolean {
  return fileTypes.every((fileType) => fileType === 'regular');
}

async function readRegularSingleLinkTarget(
  configPath: string,
): Promise<ReturnType<typeof normalizeStat>> {
  const targetLstat = normalizeStat(
    await validationIo(`Unable to inspect target ${configPath}`, () =>
      lstat(configPath, { bigint: true }),
    ),
  );
  const targetStat = normalizeStat(
    await validationIo(`Unable to stat target ${configPath}`, () =>
      stat(configPath, { bigint: true }),
    ),
  );
  if (!isRegularTargetPair([targetLstat.fileType, targetStat.fileType])) {
    throw new TerminalReplacementValidationError(
      `Migration only supports regular config files: ${configPath}`,
    );
  }
  if (targetStat.nlink !== 1n) {
    throw new TerminalReplacementValidationError(
      `Migration only supports single-link config files: ${configPath} has ${targetStat.nlink} links`,
    );
  }
  return targetStat;
}

export async function collectModifiedSnapshot(options: {
  canonicalRootDir: string;
  item: MigrationWritePlanItem;
  rootDir: string;
  validation: OriginalTargetValidationOptions;
}): Promise<ModifiedTargetSnapshot> {
  const canonicalPath = await resolveCanonicalTarget({
    canonicalRootDir: options.canonicalRootDir,
    configPath: options.item.configPath,
    rootDir: options.rootDir,
  });
  const targetStat = await readRegularSingleLinkTarget(options.item.configPath);
  await assertWritable({
    filePath: options.item.configPath,
    openFile: options.validation.openFile,
  });
  const bytes = await validationIo(
    `Unable to read target ${options.item.configPath}`,
    () => options.validation.readFileBytes(options.item.configPath),
  );
  if (!bytes.equals(options.item.originalBytes)) {
    throw new ReplacementDriftError(
      `Migration target changed since planning: ${options.item.configPath}`,
    );
  }
  return {
    ...createPreparedIdentity(bytes, targetStat),
    allowedCanonicalRootDir: normalizeAbsolutePath(options.canonicalRootDir),
    allowedRootDir: normalizeAbsolutePath(options.rootDir),
    canonicalPath: normalizeAbsolutePath(canonicalPath),
    item: options.item,
  };
}

export async function validateCanonicalTarget(
  snapshot: ModifiedTargetSnapshot,
): Promise<void> {
  await assertLogicalPathHasNoLinks(
    snapshot.allowedRootDir,
    snapshot.item.configPath,
  );
  const canonicalPath = await validationIo(
    `Unable to resolve canonical target ${snapshot.item.configPath}`,
    () => realpath(snapshot.item.configPath),
  );
  if (!isPathInsideDirectory(canonicalPath, snapshot.allowedCanonicalRootDir)) {
    throw new ReplacementDriftError(
      `Migration target moved outside the canonical workspace root: ${snapshot.item.configPath}`,
    );
  }
  assertEqual({
    actual: normalizeAbsolutePath(canonicalPath),
    expected: snapshot.canonicalPath,
    filePath: snapshot.item.configPath,
    label: 'canonical path',
  });
}

export async function validateFile(options: {
  comparison: StatComparisonOptions;
  expected: PreparedFileIdentity;
  filePath: string;
  readFileBytes: OriginalTargetValidationOptions['readFileBytes'];
}): Promise<void> {
  const currentStat = normalizeStat(
    await validationIo(`Unable to stat ${options.filePath}`, () =>
      stat(options.filePath, { bigint: true }),
    ),
  );
  const bytes = await validationIo(`Unable to read ${options.filePath}`, () =>
    options.readFileBytes(options.filePath),
  );
  assertStatMatches({
    actual: currentStat,
    comparison: options.comparison,
    expected: options.expected.stat,
    filePath: options.filePath,
  });
  assertContentMatches({
    bytes,
    expected: options.expected,
    filePath: options.filePath,
  });
}

export async function validateOriginalTarget(options: {
  snapshot: ModifiedTargetSnapshot;
  validation: OriginalTargetValidationOptions;
}): Promise<void> {
  await validateCanonicalTarget(options.snapshot);
  await assertWritable({
    filePath: options.snapshot.item.configPath,
    openFile: options.validation.openFile,
  });
  await validateFile({
    comparison: {
      compareObservedMtime: true,
      compareRestorableMtime: true,
    },
    expected: options.snapshot,
    filePath: options.snapshot.item.configPath,
    readFileBytes: options.validation.readFileBytes,
  });
}
