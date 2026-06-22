import type { LiminaCheckIssue } from '../check-reporting/snapshot';

export interface CollectedTaskIssues {
  issues: readonly LiminaCheckIssue[];
  taskId: string;
  taskOrder: number;
}

function compareStrings(left: string | undefined, right: string | undefined) {
  return (left ?? '').localeCompare(right ?? '');
}

function compareIssues(
  left: LiminaCheckIssue,
  right: LiminaCheckIssue,
): number {
  return (
    compareStrings(left.code, right.code) ||
    compareStrings(left.filePath, right.filePath) ||
    compareStrings(left.packageManifestPath, right.packageManifestPath) ||
    compareStrings(left.packageName, right.packageName) ||
    compareStrings(left.checkerName, right.checkerName) ||
    compareStrings(left.title, right.title) ||
    compareStrings(left.reason, right.reason)
  );
}

export function sortCollectedIssues(
  input: readonly CollectedTaskIssues[],
): LiminaCheckIssue[] {
  return input
    .flatMap((collected) =>
      collected.issues.map((issue) => ({
        issue,
        taskOrder: collected.taskOrder,
      })),
    )
    .toSorted(
      (left, right) =>
        left.taskOrder - right.taskOrder ||
        compareIssues(left.issue, right.issue),
    )
    .map(({ issue }) => issue);
}
