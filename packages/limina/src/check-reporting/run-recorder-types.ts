import type { LiminaCheckRunCheckItemSummary } from './snapshot';

export interface LiminaCheckRunTaskStats {
  items?: readonly LiminaCheckRunCheckItemSummary[];
  passed: number;
  total: number;
}
