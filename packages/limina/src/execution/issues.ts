import type { LiminaCheckIssue } from '../check-reporting/snapshot';

export interface CollectedTaskIssues {
  issues: readonly LiminaCheckIssue[];
  taskId: string;
  taskOrder: number;
}

function compareStrings(
  left: string | undefined,
  right: string | undefined,
): number {
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

function getIssueDeduplicationKey(issue: LiminaCheckIssue): string {
  return (
    issue.id ??
    JSON.stringify({
      checkerName: issue.checkerName,
      code: issue.code,
      detector: issue.detector,
      domain: issue.domain,
      evidence: issue.evidence,
      external: issue.external,
      filePath: issue.filePath,
      fix: issue.fix,
      fixSteps: issue.fixSteps,
      locations: issue.locations,
      packageManifestPath: issue.packageManifestPath,
      packageName: issue.packageName,
      reason: issue.reason,
      scope: issue.scope,
      summary: issue.summary,
      task: issue.task,
      title: issue.title,
      tool: issue.tool,
      verifyCommands: issue.verifyCommands,
    })
  );
}

export function sortCollectedIssues(
  input: readonly CollectedTaskIssues[],
): LiminaCheckIssue[] {
  const seenIssueKeys = new Set<string>();

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
    .filter(({ issue }) => {
      const key = getIssueDeduplicationKey(issue);

      if (seenIssueKeys.has(key)) {
        return false;
      }

      seenIssueKeys.add(key);
      return true;
    })
    .map(({ issue }) => issue);
}
