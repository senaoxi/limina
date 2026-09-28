import { stat } from 'node:fs/promises';
import {
  assertContentMatches,
  assertEqual,
  assertStatMatches,
  normalizeStat,
  validationIo,
} from './file-stat';
import { validateCanonicalTarget } from './file-validation';
import type { TransactionItem, TransactionRuntimeOptions } from './types';

function stableIdentityComparison() {
  return {
    compareObservedMtime: false,
    compareRestorableMtime: false,
  } as const;
}

export async function verifyRestoredInPlaceTarget(options: {
  item: TransactionItem;
  readFileBytes: TransactionRuntimeOptions['readFileBytes'];
}): Promise<void> {
  const snapshot = options.item.snapshot;
  const filePath = snapshot.item.configPath;
  await validateCanonicalTarget(snapshot);
  const restoredStat = normalizeStat(
    await validationIo(`Unable to stat restored target ${filePath}`, () =>
      stat(filePath, { bigint: true }),
    ),
  );
  const bytes = await validationIo(
    `Unable to read restored target ${filePath}`,
    () => options.readFileBytes(filePath),
  );
  assertStatMatches({
    actual: restoredStat,
    comparison: stableIdentityComparison(),
    expected: snapshot.stat,
    filePath,
  });
  assertContentMatches({ bytes, expected: snapshot, filePath });
  const metadata: readonly [unknown, unknown, string][] = [
    [
      restoredStat.permissionMode,
      snapshot.stat.permissionMode,
      'permission mode',
    ],
    [restoredStat.uid, snapshot.stat.uid, 'uid'],
    [restoredStat.gid, snapshot.stat.gid, 'gid'],
    [
      restoredStat.timestamp.restorableMtimeMs,
      snapshot.stat.timestamp.restorableMtimeMs,
      'restorable mtime',
    ],
  ];
  for (const [actual, expected, label] of metadata) {
    assertEqual({ actual, expected, filePath, label });
  }
}
