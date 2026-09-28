import type { CheckIssueSnapshot } from '../../src/check-reporting/snapshot';

export type DetectorStructuredSnapshotKind =
  | 'check-run'
  | 'standalone-invocation';

export interface DetectorStructuredSnapshotResult {
  readonly kind: DetectorStructuredSnapshotKind;
  readonly snapshot: CheckIssueSnapshot;
  readonly snapshotPath: string;
}

export interface SnapshotReadOptions {
  readonly command: readonly string[];
  readonly fixtureId: string;
  readonly invocationStartedAtMs: number;
  readonly repoRoot: string;
}
