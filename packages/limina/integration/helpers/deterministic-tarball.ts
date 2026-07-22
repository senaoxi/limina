import { createHash } from 'node:crypto';
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
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface DeterministicPackageTarball {
  readonly bytes: Buffer;
  readonly integrity: string;
  readonly shasum: string;
}

async function normalizeTreeTimestamps(directoryPath: string): Promise<void> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    comparePortableNames(left.name, right.name),
  )) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      await normalizeTreeTimestamps(entryPath);
    }
    await chmod(entryPath, entry.isDirectory() ? 0o755 : 0o644);
    await utimes(entryPath, FIXED_ARCHIVE_TIME, FIXED_ARCHIVE_TIME);
  }
  await chmod(directoryPath, 0o755);
  await utimes(directoryPath, FIXED_ARCHIVE_TIME, FIXED_ARCHIVE_TIME);
}

export async function createDeterministicPackageTarball(options: {
  readonly files: readonly LocalRegistryPackageFile[];
  readonly tempRoot: string;
}): Promise<DeterministicPackageTarball> {
  const files = [...options.files].sort((left, right) =>
    comparePortableNames(left.path, right.path),
  );
  if (!files.some((file) => file.path === 'package.json')) {
    throw new Error('Deterministic package tarballs require package.json.');
  }
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error(
      'Deterministic package tarball files must have unique paths.',
    );
  }

  await mkdir(options.tempRoot, { recursive: true });
  const packageRoot = await mkdtemp(
    path.join(options.tempRoot, 'release-registry-package-'),
  );
  let packed: Awaited<ReturnType<typeof packOutputTarball>> | undefined;

  try {
    for (const file of files) {
      const filePath = resolvePortablePathInside(
        packageRoot,
        file.path,
        'deterministic tarball file path',
      );
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, file.content, 'utf8');
    }
    await normalizeTreeTimestamps(packageRoot);

    packed = await packOutputTarball(packageRoot);
    const bytes = Buffer.from(packed.tarball);

    return {
      bytes,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      shasum: createHash('sha1').update(bytes).digest('hex'),
    };
  } finally {
    await packed?.cleanup();
    await rm(packageRoot, { force: true, recursive: true });
  }
}
