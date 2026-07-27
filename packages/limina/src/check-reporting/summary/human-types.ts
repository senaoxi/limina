import type {
  CheckIssueInventoryPresentationOptions,
  InventoryQueryContext,
} from '../inventory-presentation';
import type {
  CheckIssueInventoryFilters,
  CheckIssueSnapshot,
  LiminaCheckIssue,
  LiminaCheckRunSummary,
} from '../snapshot';

export interface CheckRunSummaryHumanOptions {
  color: boolean;
  issues: readonly LiminaCheckIssue[];
  queryContext?: InventoryQueryContext;
  rootDir?: string;
  run: LiminaCheckRunSummary;
  verbose?: boolean;
}

export interface CheckIssueSnapshotSummaryHumanOptions {
  color: boolean;
  filteredIssueCount?: number;
  filters?: CheckIssueInventoryFilters;
  issues: readonly LiminaCheckIssue[];
  presentation: CheckIssueInventoryPresentationOptions;
  queryContext: InventoryQueryContext;
  rootDir?: string;
  snapshot: CheckIssueSnapshot;
  totalIssueCount?: number;
}
