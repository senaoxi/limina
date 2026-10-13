import {
  ReplacementDriftError,
  TerminalReplacementValidationError,
} from 'limina/internal/check-reporting/atomic-writer';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
} from 'limina/internal/utils/path';
import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'pathe';
import { assertEqual, normalizeStat } from './file-stat';
import { assertLogicalPathHasNoLinks } from './file-validation';
import type { AllowedRoot } from './setup';
import type { CreatedTargetSnapshot, MigrationCreatePlanItem } from './types';

export async function assertAbsent(file: string): Promise<void> {
  try {
    await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new ReplacementDriftError(
    `Migration create target already exists: ${file}`,
  );
}
export async function collectCreatedSnapshot(
  item: MigrationCreatePlanItem,
  root: AllowedRoot,
): Promise<CreatedTargetSnapshot> {
  const parent = path.dirname(item.configPath);
  await assertLogicalPathHasNoLinks(root.rootDir, parent);
  const canonicalParent = normalizeAbsolutePath(await realpath(parent));
  if (!isPathInsideDirectory(canonicalParent, root.canonicalRootDir))
    throw new TerminalReplacementValidationError(
      `Migration create target escapes the physical root: ${item.configPath}`,
    );
  await assertAbsent(item.configPath);
  return {
    item,
    allowedRootDir: root.rootDir,
    allowedCanonicalRootDir: root.canonicalRootDir,
    canonicalParent,
    parentStat: normalizeStat(await stat(parent, { bigint: true })),
  };
}
export async function validateCreationParent(
  snapshot: CreatedTargetSnapshot,
): Promise<void> {
  const parent = path.dirname(snapshot.item.configPath);
  await assertLogicalPathHasNoLinks(snapshot.allowedRootDir, parent);
  const canonical = normalizeAbsolutePath(await realpath(parent));
  const current = normalizeStat(await stat(parent, { bigint: true }));
  for (const [label, actual, expected] of [
    ['canonical parent', canonical, snapshot.canonicalParent],
    ['parent device', current.dev, snapshot.parentStat.dev],
    ['parent inode', current.ino, snapshot.parentStat.ino],
  ] as const)
    assertEqual({ actual, expected, filePath: parent, label });
}
