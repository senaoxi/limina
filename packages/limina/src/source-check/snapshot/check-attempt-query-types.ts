import type { CheckIssueSnapshot } from './types';

export type CheckAttemptQueryState =
  | 'aborted'
  | 'completed'
  | 'completed-inconsistent'
  | 'incomplete'
  | 'interrupted'
  | 'latest-attempt-corrupt'
  | 'legacy'
  | 'persistence-failed'
  | 'running';

export type CheckAttemptQueryResult =
  | {
      message: string;
      snapshot: null;
      state: Exclude<CheckAttemptQueryState, 'completed' | 'legacy'>;
    }
  | {
      message?: undefined;
      snapshot: CheckIssueSnapshot | null;
      state: 'legacy';
    }
  | {
      message?: undefined;
      snapshot: CheckIssueSnapshot;
      state: 'completed';
    };
