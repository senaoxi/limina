import type { LiminaCheckIssue } from '../snapshot';
import { getGroupLocations } from './groups';
import { isStructuredGraphPrepareIssue } from './issue-details';
import type { IssueGroup } from './types';

function hasIssueDetailLines(issue: LiminaCheckIssue): boolean {
  if (issue.detailLines === undefined) return false;
  return issue.detailLines.length > 0;
}

function hasStructuredPrepareDetails(issue: LiminaCheckIssue): boolean {
  if (!isStructuredGraphPrepareIssue(issue)) return false;
  return hasIssueDetailLines(issue);
}

function hasTruncatedIssueCount(
  group: IssueGroup,
  detailLimit: number,
): boolean {
  if (group.issues.length <= 1) return false;
  return group.issues.length > detailLimit;
}

function getDetailLineCount(issue: LiminaCheckIssue): number {
  return issue.detailLines === undefined ? 0 : issue.detailLines.length;
}

function getEvidenceLineCount(issue: LiminaCheckIssue): number {
  if (issue.evidence === undefined) return 0;
  return issue.evidence.reduce((count, evidence) => {
    const lineCount = evidence.lines === undefined ? 0 : evidence.lines.length;
    return count + lineCount;
  }, 0);
}

function getSingleIssueDetailCount(group: IssueGroup): number {
  if (group.issues.length !== 1) return 0;
  const issue = group.issues[0]!;
  return getDetailLineCount(issue) + getEvidenceLineCount(issue);
}

function isGroupTruncated(group: IssueGroup, detailLimit: number): boolean {
  const checks = [
    group.issues.some(hasStructuredPrepareDetails),
    getGroupLocations(group).length > detailLimit,
    hasTruncatedIssueCount(group, detailLimit),
    getSingleIssueDetailCount(group) > detailLimit,
  ];
  return checks.some(Boolean);
}

export function hasTruncatedGroups(
  groups: readonly IssueGroup[],
  detailLimit: number,
): boolean {
  return groups.some((group) => isGroupTruncated(group, detailLimit));
}
