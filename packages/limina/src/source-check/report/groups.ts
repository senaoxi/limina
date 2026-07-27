import { uniqueSortedStrings } from '#utils/collections';
import { isSourceStructuredIssue, isSourceUnusedModuleIssue } from './filters';
import { getGenericSourceIssueLocation } from './locations';
import type {
  GenericSourceIssueGroup,
  SourceCheckIssue,
  SourceStructuredIssue,
  SourceUnusedModuleIssue,
  SourceUnusedWorkspaceDependencyIssue,
} from './types';
import { SOURCE_ISSUE_CODES } from './types';

function getOrCreateGroup<T>(groups: Map<string, T[]>, key: string): T[] {
  const existing = groups.get(key);
  if (existing !== undefined) return existing;
  const created: T[] = [];
  groups.set(key, created);
  return created;
}

function getUnusedGroupKey(issue: {
  code: string;
  ownerName: string;
  packageJsonPath: string;
}): string {
  return [issue.code, issue.ownerName, issue.packageJsonPath].join('\0');
}

function getFirstOwnerName(group: readonly { ownerName: string }[]): string {
  const first = group[0];
  return first === undefined ? '' : first.ownerName;
}

function getFirstManifestPath(
  group: readonly { packageJsonPath: string }[],
): string {
  const first = group[0];
  return first === undefined ? '' : first.packageJsonPath;
}

function compareOwnerGroups<
  T extends { ownerName: string; packageJsonPath: string },
>(left: readonly T[], right: readonly T[]): number {
  const ownerOrder = getFirstOwnerName(left).localeCompare(
    getFirstOwnerName(right),
  );
  if (ownerOrder !== 0) return ownerOrder;
  return getFirstManifestPath(left).localeCompare(getFirstManifestPath(right));
}

function compareModuleIssues(
  left: SourceUnusedModuleIssue,
  right: SourceUnusedModuleIssue,
): number {
  return left.filePath.localeCompare(right.filePath);
}

export function groupUnusedModuleIssues(
  issues: readonly SourceCheckIssue[],
): SourceUnusedModuleIssue[][] {
  const groups = new Map<string, SourceUnusedModuleIssue[]>();
  for (const issue of issues) {
    if (!isSourceUnusedModuleIssue(issue)) continue;
    getOrCreateGroup(groups, getUnusedGroupKey(issue)).push(issue);
  }
  return [...groups.values()]
    .map((group) => group.sort(compareModuleIssues))
    .sort(compareOwnerGroups);
}

export function isSourceUnusedWorkspaceDependencyIssue(
  issue: SourceCheckIssue,
): issue is SourceUnusedWorkspaceDependencyIssue {
  return issue.code === SOURCE_ISSUE_CODES.unusedWorkspaceDependency;
}

function compareDependencyIssues(
  left: SourceUnusedWorkspaceDependencyIssue,
  right: SourceUnusedWorkspaceDependencyIssue,
): number {
  return left.dependencyName.localeCompare(right.dependencyName);
}

export function groupUnusedWorkspaceDependencyIssues(
  issues: readonly SourceCheckIssue[],
): SourceUnusedWorkspaceDependencyIssue[][] {
  const groups = new Map<string, SourceUnusedWorkspaceDependencyIssue[]>();
  for (const issue of issues) {
    if (!isSourceUnusedWorkspaceDependencyIssue(issue)) continue;
    getOrCreateGroup(groups, getUnusedGroupKey(issue)).push(issue);
  }
  return [...groups.values()]
    .map((group) => group.sort(compareDependencyIssues))
    .sort(compareOwnerGroups);
}

function valueOrEmpty(value: string | undefined): string {
  return value ?? '';
}

function jsonOrNull(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function getGenericGroupKey(issue: SourceStructuredIssue): string {
  return [
    issue.code,
    issue.title,
    issue.ownerName,
    valueOrEmpty(issue.packageJsonPath),
    issue.reason,
    valueOrEmpty(issue.fix),
    jsonOrNull(issue.fixSteps),
  ].join('\0');
}

function compareGenericIssues(
  left: SourceStructuredIssue,
  right: SourceStructuredIssue,
): number {
  return getGenericSourceIssueLocation(left).localeCompare(
    getGenericSourceIssueLocation(right),
  );
}

function getFirstGenericIssue(
  group: GenericSourceIssueGroup,
): SourceStructuredIssue | undefined {
  return group.issues[0];
}

function getGenericGroupCode(group: GenericSourceIssueGroup): string {
  const issue = getFirstGenericIssue(group);
  return issue === undefined ? '' : issue.code;
}

function getGenericGroupOwner(group: GenericSourceIssueGroup): string {
  const issue = getFirstGenericIssue(group);
  return issue === undefined ? '' : issue.ownerName;
}

function compareGenericGroups(
  left: GenericSourceIssueGroup,
  right: GenericSourceIssueGroup,
): number {
  const codeOrder = getGenericGroupCode(left).localeCompare(
    getGenericGroupCode(right),
  );
  if (codeOrder !== 0) return codeOrder;
  const ownerOrder = getGenericGroupOwner(left).localeCompare(
    getGenericGroupOwner(right),
  );
  return ownerOrder === 0 ? left.key.localeCompare(right.key) : ownerOrder;
}

export function groupGenericSourceIssues(
  issues: readonly SourceCheckIssue[],
): GenericSourceIssueGroup[] {
  const groups = new Map<string, SourceStructuredIssue[]>();
  for (const issue of issues) {
    if (!isSourceStructuredIssue(issue)) continue;
    getOrCreateGroup(groups, getGenericGroupKey(issue)).push(issue);
  }
  return [...groups.entries()]
    .map(([key, groupedIssues]) => ({
      issues: groupedIssues.sort(compareGenericIssues),
      key,
    }))
    .sort(compareGenericGroups);
}

export function getOwnerNames(
  groups: readonly (readonly { ownerName: string }[])[],
): string[] {
  return uniqueSortedStrings(
    groups.flatMap((group) => {
      const first = group[0];
      return first === undefined ? [] : [first.ownerName];
    }),
  );
}
