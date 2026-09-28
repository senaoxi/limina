import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { packOutputTarball } from '../../src/package-check/runner';
import type { LocalRegistryPackageFile } from './detector-fixture-types';
import { resolvePortablePathInside } from './fixture-paths';

const FIXED_ARCHIVE_TIME = new Date('2000-01-01T00:00:00.000Z');

function comparePortableNames(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

export interface DeterministicPackageTarball {
  readonly bytes: Buffer;
  readonly integrity: string;
  readonly shasum: string;
}

async function normalizeEntryTimestamp(options: {
  entry: Dirent<string>;
  parentDirectory: string;
}): Promise<void> {
  const entryPath = path.join(options.parentDirectory, options.entry.name);
  if (options.entry.isDirectory()) await normalizeTreeTimestamps(entryPath);
  await chmod(entryPath, options.entry.isDirectory() ? 0o755 : 0o644);
  await utimes(entryPath, FIXED_ARCHIVE_TIME, FIXED_ARCHIVE_TIME);
}

async function normalizeTreeTimestamps(directoryPath: string): Promise<void> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const sortedEntries = entries.sort((left, right) =>
    comparePortableNames(left.name, right.name),
  );
  for (const entry of sortedEntries) {
    await normalizeEntryTimestamp({ entry, parentDirectory: directoryPath });
  }
  await chmod(directoryPath, 0o755);
  await utimes(directoryPath, FIXED_ARCHIVE_TIME, FIXED_ARCHIVE_TIME);
}

function validatePackageFiles(
  files: readonly LocalRegistryPackageFile[],
): void {
  if (!files.some((file) => file.path === 'package.json')) {
    throw new Error('Deterministic package tarballs require package.json.');
  }
  const uniquePathCount = new Set(files.map((file) => file.path)).size;
  if (uniquePathCount === files.length) return;
  throw new Error(
    'Deterministic package tarball files must have unique paths.',
  );
}

async function writePackageFiles(options: {
  files: readonly LocalRegistryPackageFile[];
  packageRoot: string;
}): Promise<void> {
  for (const file of options.files) {
    const filePath = resolvePortablePathInside(
      options.packageRoot,
      file.path,
      'deterministic tarball file path',
    );
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, file.content, 'utf8');
  }
}

function createTarballResult(bytes: Buffer): DeterministicPackageTarball {
  return {
    bytes,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    shasum: createHash('sha1').update(bytes).digest('hex'),
  };
}

export async function createDeterministicPackageTarball(options: {
  readonly files: readonly LocalRegistryPackageFile[];
  readonly tempRoot: string;
}): Promise<DeterministicPackageTarball> {
  const files = [...options.files].sort((left, right) =>
    comparePortableNames(left.path, right.path),
  );
  validatePackageFiles(files);
  await mkdir(options.tempRoot, { recursive: true });
  const packageRoot = await mkdtemp(
    path.join(options.tempRoot, 'release-registry-package-'),
  );
  let packed: Awaited<ReturnType<typeof packOutputTarball>> | undefined;

  try {
    await writePackageFiles({ files, packageRoot });
    await normalizeTreeTimestamps(packageRoot);
    packed = await packOutputTarball(packageRoot);
    return createTarballResult(Buffer.from(packed.tarball));
  } finally {
    await packed?.cleanup();
    await rm(packageRoot, { force: true, recursive: true });
  }
}
