import { getCheckIssueSnapshotPath } from '../../src/check-reporting/snapshot';
import {
  assertNoPreexistingCheckSnapshot,
  readDetectorCheckSnapshot,
} from './detector-check-snapshot';
import type {
  DetectorStructuredSnapshotKind,
  DetectorStructuredSnapshotResult,
  SnapshotReadOptions,
} from './detector-snapshot-types';
import {
  assertNoPreexistingStandaloneSnapshots,
  getExpectedStandaloneCommand,
  readDetectorStandaloneInvocation,
} from './detector-standalone-snapshot';

export {
  assertNoPreexistingCheckSnapshot,
  readDetectorCheckSnapshot,
} from './detector-check-snapshot';
export type {
  DetectorStructuredSnapshotKind,
  DetectorStructuredSnapshotResult,
} from './detector-snapshot-types';

export function getDetectorStructuredSnapshotKind(
  command: readonly string[],
): DetectorStructuredSnapshotKind {
  if (command[0] === 'check') return 'check-run';
  getExpectedStandaloneCommand(command);
  return 'standalone-invocation';
}

export async function assertNoPreexistingDetectorSnapshots(
  repoRoot: string,
): Promise<void> {
  await assertNoPreexistingCheckSnapshot(repoRoot);
  await assertNoPreexistingStandaloneSnapshots(repoRoot);
}

export async function readDetectorStructuredSnapshot(
  options: SnapshotReadOptions,
): Promise<DetectorStructuredSnapshotResult> {
  if (getDetectorStructuredSnapshotKind(options.command) === 'check-run') {
    return {
      kind: 'check-run',
      snapshot: await readDetectorCheckSnapshot(options),
      snapshotPath: getCheckIssueSnapshotPath(options.repoRoot),
    };
  }
  return readDetectorStandaloneInvocation(options);
}
