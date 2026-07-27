import { normalizeAbsolutePath } from '#utils/path';
import type { JSONReport } from 'knip';
import path from 'pathe';
import type {
  KnipUnusedSourceFileIssue,
  KnipUnusedWorkspaceDependencyIssue,
} from './types';

interface KnipJsonDependencyItem {
  name: string;
}

const dependencyIssueFields = [
  'dependencies',
  'devDependencies',
  'optionalPeerDependencies',
] as const;

type DependencyIssueField = (typeof dependencyIssueFields)[number];
type KnipIssueEntry = JSONReport['issues'][number];

function isPackageJsonFile(value: unknown): value is string {
  return typeof value === 'string' && value.endsWith('package.json');
}

function resolvePackageJsonPath(rootDir: string, file: unknown): string | null {
  if (!isPackageJsonFile(file)) {
    return null;
  }

  return normalizeAbsolutePath(
    path.isAbsolute(file) ? file : path.join(rootDir, file),
  );
}

function getDependencyItems(
  entry: KnipIssueEntry,
  field: DependencyIssueField,
): KnipJsonDependencyItem[] {
  const value = entry[field] as KnipJsonDependencyItem[] | undefined;
  return Array.isArray(value) ? value : [];
}

function createDependencyIssue(options: {
  dependency: KnipJsonDependencyItem;
  field: DependencyIssueField;
  packageJsonPath: string;
  workspacePackageNames: ReadonlySet<string>;
}): KnipUnusedWorkspaceDependencyIssue | null {
  if (typeof options.dependency.name !== 'string') {
    return null;
  }

  if (!options.workspacePackageNames.has(options.dependency.name)) {
    return null;
  }

  return {
    dependencyName: options.dependency.name,
    externalCode: options.field,
    packageJsonPath: options.packageJsonPath,
  };
}

function appendDependencyIssue(options: {
  dependency: KnipJsonDependencyItem;
  field: DependencyIssueField;
  issues: KnipUnusedWorkspaceDependencyIssue[];
  packageJsonPath: string;
  workspacePackageNames: ReadonlySet<string>;
}): void {
  const issue = createDependencyIssue(options);
  if (issue !== null) {
    options.issues.push(issue);
  }
}

function collectEntryDependencyIssues(options: {
  entry: KnipIssueEntry;
  packageJsonPath: string;
  workspacePackageNames: ReadonlySet<string>;
}): KnipUnusedWorkspaceDependencyIssue[] {
  const issues: KnipUnusedWorkspaceDependencyIssue[] = [];

  for (const field of dependencyIssueFields) {
    for (const dependency of getDependencyItems(options.entry, field)) {
      appendDependencyIssue({
        ...options,
        dependency,
        field,
        issues,
      });
    }
  }

  return issues;
}

function compareDependencyIssues(
  left: KnipUnusedWorkspaceDependencyIssue,
  right: KnipUnusedWorkspaceDependencyIssue,
): number {
  const pathOrder = left.packageJsonPath.localeCompare(right.packageJsonPath);
  if (pathOrder !== 0) {
    return pathOrder;
  }

  return left.dependencyName.localeCompare(right.dependencyName);
}

function addEntryDependencyIssues(options: {
  entry: KnipIssueEntry;
  issuesByKey: Map<string, KnipUnusedWorkspaceDependencyIssue>;
  rootDir: string;
  workspacePackageNames: ReadonlySet<string>;
}): void {
  const packageJsonPath = resolvePackageJsonPath(
    options.rootDir,
    options.entry.file,
  );
  if (packageJsonPath === null) {
    return;
  }

  const issues = collectEntryDependencyIssues({
    entry: options.entry,
    packageJsonPath,
    workspacePackageNames: options.workspacePackageNames,
  });
  for (const issue of issues) {
    options.issuesByKey.set(
      `${issue.packageJsonPath}\0${issue.dependencyName}`,
      issue,
    );
  }
}

export function collectUnusedWorkspaceDependencyIssues(options: {
  report: JSONReport;
  rootDir: string;
  workspacePackageNames: ReadonlySet<string>;
}): KnipUnusedWorkspaceDependencyIssue[] {
  const issuesByKey = new Map<string, KnipUnusedWorkspaceDependencyIssue>();

  for (const entry of options.report.issues) {
    addEntryDependencyIssues({ ...options, entry, issuesByKey });
  }

  return [...issuesByKey.values()].sort(compareDependencyIssues);
}

function toAbsoluteIssuePath(rootDir: string, filePath: string): string {
  return normalizeAbsolutePath(
    path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath),
  );
}

function isNonEmptyFileName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function collectNestedFileNames(entry: KnipIssueEntry): string[] | null {
  if (!Array.isArray(entry.files) || entry.files.length === 0) {
    return null;
  }

  return entry.files.map((file) => file.name).filter(isNonEmptyFileName);
}

function isTopLevelSourceFile(value: unknown): value is string {
  return typeof value === 'string' && !value.endsWith('package.json');
}

function collectEntryFileNames(entry: KnipIssueEntry): string[] {
  const nestedNames = collectNestedFileNames(entry);
  if (nestedNames !== null) {
    return nestedNames;
  }

  if (isTopLevelSourceFile(entry.file)) {
    return [entry.file];
  }

  return [];
}

export function collectUnusedSourceFileIssues(options: {
  report: JSONReport;
  rootDir: string;
}): KnipUnusedSourceFileIssue[] {
  const filePaths = new Set<string>();

  for (const entry of options.report.issues) {
    for (const fileName of collectEntryFileNames(entry)) {
      filePaths.add(toAbsoluteIssuePath(options.rootDir, fileName));
    }
  }

  return [...filePaths]
    .sort((left, right) => left.localeCompare(right))
    .map((filePath) => ({
      externalCode: 'files' as const,
      filePath,
    }));
}
