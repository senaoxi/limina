import { compareCodeUnits } from '#utils/collections';
import { isPlainRecord } from '#utils/values';
import { createHash } from 'node:crypto';
import type {
  ContentHashDiff,
  ContentHashDiffGroup,
  ContentHashIgnoreRule,
  IgnoredContentHashDiffGroup,
  PackedArtifactContent,
  PackedPackageContentFile,
} from '../consistency/types';
import { CONTENT_HASH_DIFF_KINDS } from '../consistency/types';
import { getPackedContentFiles, unpackPackedPackage } from '../packed/archive';

export function createContentHashDiffGroup(): ContentHashDiffGroup {
  return { changed: [], 'local-only': [], 'remote-only': [] };
}

function addContentHashDiff(
  group: ContentHashDiffGroup,
  diff: ContentHashDiff,
): void {
  group[diff.kind].push(diff);
}

function compareDiffPath(
  left: ContentHashDiff,
  right: ContentHashDiff,
): number {
  return compareCodeUnits(left.relativePath, right.relativePath);
}

function sortContentHashDiffGroup(group: ContentHashDiffGroup): void {
  for (const kind of CONTENT_HASH_DIFF_KINDS) group[kind].sort(compareDiffPath);
}

export function countContentHashDiffs(group: ContentHashDiffGroup): number {
  return CONTENT_HASH_DIFF_KINDS.reduce(
    (count, kind) => count + group[kind].length,
    0,
  );
}

export function hasContentHashDiffs(group: ContentHashDiffGroup): boolean {
  return countContentHashDiffs(group) > 0;
}

function normalizeVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const version = value.trim();
  return version.length > 0 ? version : null;
}

function getManifestVersion(manifest: unknown): string | null {
  if (!isPlainRecord(manifest)) return null;
  return normalizeVersion(manifest.version);
}

function parseManifestVersion(data: Uint8Array): string | null {
  try {
    const manifest = JSON.parse(Buffer.from(data).toString('utf8')) as unknown;
    return getManifestVersion(manifest);
  } catch {
    return null;
  }
}

function readPackedPackageVersion(
  contentFiles: readonly PackedPackageContentFile[],
): string | null {
  const packageJsonFile = contentFiles.find(
    (file) => file.relativePath === 'package.json',
  );
  if (packageJsonFile === undefined) return null;
  return parseManifestVersion(packageJsonFile.data);
}

export async function readPackedArtifactContent(
  tarball: Buffer,
): Promise<PackedArtifactContent> {
  const packedPackage = await unpackPackedPackage(tarball);
  const contentFiles = getPackedContentFiles(packedPackage);
  return {
    filesByPath: new Map(contentFiles.map((file) => [file.relativePath, file])),
    packageVersion: readPackedPackageVersion(contentFiles),
  };
}

function fileDataEquals(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function hashFileData(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function createLocalOnlyDiff(options: {
  file: PackedPackageContentFile;
  relativePath: string;
}): ContentHashDiff {
  return {
    kind: 'local-only',
    localHash: hashFileData(options.file.data),
    relativePath: options.relativePath,
  };
}

function createRemoteOnlyDiff(options: {
  file: PackedPackageContentFile;
  relativePath: string;
}): ContentHashDiff {
  return {
    kind: 'remote-only',
    relativePath: options.relativePath,
    remoteHash: hashFileData(options.file.data),
  };
}

function createChangedDiff(options: {
  localFile: PackedPackageContentFile;
  relativePath: string;
  remoteFile: PackedPackageContentFile;
}): ContentHashDiff {
  return {
    kind: 'changed',
    localHash: hashFileData(options.localFile.data),
    relativePath: options.relativePath,
    remoteHash: hashFileData(options.remoteFile.data),
  };
}

function createLocalSideDiff(options: {
  localFile: PackedPackageContentFile | undefined;
  relativePath: string;
  remoteFile: PackedPackageContentFile | undefined;
}): ContentHashDiff | null {
  if (options.localFile === undefined) return null;
  if (options.remoteFile !== undefined) return null;
  return createLocalOnlyDiff({
    file: options.localFile,
    relativePath: options.relativePath,
  });
}

function createRemoteSideDiff(options: {
  localFile: PackedPackageContentFile | undefined;
  relativePath: string;
  remoteFile: PackedPackageContentFile | undefined;
}): ContentHashDiff | null {
  if (options.remoteFile === undefined) return null;
  if (options.localFile !== undefined) return null;
  return createRemoteOnlyDiff({
    file: options.remoteFile,
    relativePath: options.relativePath,
  });
}

function getComparableFiles(options: {
  localFile: PackedPackageContentFile | undefined;
  remoteFile: PackedPackageContentFile | undefined;
}): {
  localFile: PackedPackageContentFile;
  remoteFile: PackedPackageContentFile;
} | null {
  if (options.localFile === undefined) return null;
  if (options.remoteFile === undefined) return null;
  return { localFile: options.localFile, remoteFile: options.remoteFile };
}

function createTwoSidedDiff(options: {
  localFile: PackedPackageContentFile | undefined;
  relativePath: string;
  remoteFile: PackedPackageContentFile | undefined;
}): ContentHashDiff | null {
  const files = getComparableFiles(options);
  if (files === null) return null;
  if (fileDataEquals(files.localFile.data, files.remoteFile.data)) return null;
  return createChangedDiff({ ...files, relativePath: options.relativePath });
}

function createPathDiff(options: {
  localArtifact: PackedArtifactContent;
  relativePath: string;
  remoteArtifact: PackedArtifactContent;
}): ContentHashDiff | null {
  const files = {
    localFile: options.localArtifact.filesByPath.get(options.relativePath),
    relativePath: options.relativePath,
    remoteFile: options.remoteArtifact.filesByPath.get(options.relativePath),
  };
  return (
    createLocalSideDiff(files) ??
    createRemoteSideDiff(files) ??
    createTwoSidedDiff(files)
  );
}

export function createContentHashDiffs(options: {
  localArtifact: PackedArtifactContent;
  remoteArtifact: PackedArtifactContent;
}): ContentHashDiff[] {
  const paths = new Set([
    ...options.localArtifact.filesByPath.keys(),
    ...options.remoteArtifact.filesByPath.keys(),
  ]);
  return [...paths].sort(compareCodeUnits).flatMap((relativePath) => {
    const diff = createPathDiff({ ...options, relativePath });
    return diff === null ? [] : [diff];
  });
}

function getIgnoredGroupIndex(options: {
  diff: ContentHashDiff;
  ignoreRules: readonly ContentHashIgnoreRule[];
}): number {
  return options.ignoreRules.findIndex((rule) =>
    rule.matches(options.diff.relativePath),
  );
}

function routeContentHashDiff(options: {
  diff: ContentHashDiff;
  ignoreRules: readonly ContentHashIgnoreRule[];
  ignoredDiffGroups: IgnoredContentHashDiffGroup[];
  releaseRelevantDiffs: ContentHashDiffGroup;
}): void {
  const index = getIgnoredGroupIndex(options);
  if (index === -1) {
    addContentHashDiff(options.releaseRelevantDiffs, options.diff);
    return;
  }
  addContentHashDiff(options.ignoredDiffGroups[index]!.diffs, options.diff);
}

export function partitionContentHashDiffs(options: {
  diffs: readonly ContentHashDiff[];
  ignoreRules: readonly ContentHashIgnoreRule[];
}): {
  ignoredDiffGroups: IgnoredContentHashDiffGroup[];
  releaseRelevantDiffs: ContentHashDiffGroup;
} {
  const releaseRelevantDiffs = createContentHashDiffGroup();
  const ignoredDiffGroups = options.ignoreRules.map((rule) => ({
    diffs: createContentHashDiffGroup(),
    label: rule.label,
  }));
  for (const diff of options.diffs) {
    routeContentHashDiff({
      diff,
      ignoreRules: options.ignoreRules,
      ignoredDiffGroups,
      releaseRelevantDiffs,
    });
  }
  sortContentHashDiffGroup(releaseRelevantDiffs);
  for (const group of ignoredDiffGroups) sortContentHashDiffGroup(group.diffs);
  return {
    ignoredDiffGroups: ignoredDiffGroups.filter((group) =>
      hasContentHashDiffs(group.diffs),
    ),
    releaseRelevantDiffs,
  };
}

export {
  formatContentHashComparisonReport,
  formatIgnoredContentHashDiffs,
  formatReleaseRelevantContentHashDiffs,
} from './report';
