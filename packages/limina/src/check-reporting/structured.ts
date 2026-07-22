import { normalizeSlashes, toRelativePath } from '#utils/path';
import { createHash } from 'node:crypto';
import path from 'pathe';
import {
  assertIssueTaskMatchesCode,
  assertWritableLiminaCheckIssueCode,
  defaultTaskFailureCode,
  type LiminaWritableCheckIssueCode,
} from './codes';
import type {
  CanonicalLiminaCheckIssue,
  LiminaCheckIssue,
  LiminaCheckIssueEvidence,
  LiminaCheckIssueExternal,
  LiminaCheckIssueLocation,
  LiminaCheckIssueSeverity,
  LiminaCheckTaskName,
} from './snapshot';

export interface CreateLiminaCheckIssueOptions {
  checkerName?: string;
  code?: LiminaWritableCheckIssueCode;
  detailLines?: readonly string[];
  detector?: string;
  domain?: string;
  evidence?: readonly LiminaCheckIssueEvidence[];
  external?: LiminaCheckIssueExternal;
  filePath?: string;
  fix?: string;
  fixSteps?: readonly string[];
  id?: string;
  locations?: readonly LiminaCheckIssueLocation[];
  packageManifestPath?: string;
  packageName?: string;
  reason?: string;
  rootDir: string;
  scope?: string;
  severity?: LiminaCheckIssueSeverity;
  summary?: string;
  task: LiminaCheckTaskName;
  title?: string;
  tool?: string;
  verifyCommands?: readonly string[];
}

function stripLineColumnSuffix(filePath: string): string {
  return filePath.replace(/:\d+(?::\d+)?(?:\s+\(.+\))?$/u, '');
}

export function normalizeCheckIssuePath(
  rootDir: string,
  filePath: string | undefined,
): string | undefined {
  if (!filePath) {
    return undefined;
  }

  const trimmedPath = stripLineColumnSuffix(filePath.trim());

  if (!trimmedPath) {
    return undefined;
  }

  return normalizeSlashes(
    path.isAbsolute(trimmedPath)
      ? toRelativePath(rootDir, trimmedPath)
      : trimmedPath.replaceAll(/^\.\//gu, ''),
  );
}

export function deriveCheckIssueScope(
  issue: Pick<
    LiminaCheckIssue,
    'filePath' | 'locations' | 'packageManifestPath' | 'scope'
  >,
): string | undefined {
  if (issue.scope) {
    return issue.scope;
  }

  const locationPath =
    issue.filePath ??
    issue.locations?.find((location) => location.filePath)?.filePath ??
    issue.packageManifestPath ??
    issue.locations?.find((location) => location.packageManifestPath)
      ?.packageManifestPath;

  if (!locationPath) {
    return undefined;
  }

  const directory = path.posix.dirname(locationPath);

  return directory === '.' ? '.' : directory;
}

function normalizeLocation(
  rootDir: string,
  location: LiminaCheckIssueLocation,
): LiminaCheckIssueLocation {
  return {
    ...location,
    filePath: normalizeCheckIssuePath(rootDir, location.filePath),
    packageManifestPath: normalizeCheckIssuePath(
      rootDir,
      location.packageManifestPath,
    ),
    scope: location.scope ? normalizeSlashes(location.scope) : undefined,
  };
}

function normalizeEvidence(
  evidence: readonly LiminaCheckIssueEvidence[] | undefined,
): LiminaCheckIssueEvidence[] | undefined {
  if (!evidence?.length) {
    return undefined;
  }

  return evidence.map((item) => ({
    ...item,
    lines: item.lines ? [...item.lines] : undefined,
  }));
}

function createIssueId(issue: Omit<CanonicalLiminaCheckIssue, 'id'>): string {
  const hash = createHash('sha1')
    .update(
      JSON.stringify({
        checkerName: issue.checkerName,
        code: issue.code,
        filePath: issue.filePath,
        locations: issue.locations,
        packageManifestPath: issue.packageManifestPath,
        packageName: issue.packageName,
        scope: issue.scope,
        summary: issue.summary,
        task: issue.task,
        title: issue.title,
        tool: issue.tool,
      }),
    )
    .digest('hex')
    .slice(0, 12);

  return `${issue.task}:${issue.code}:${hash}`;
}

function inferDomain(task: LiminaCheckTaskName): string {
  return task.split(':')[0] ?? task;
}

export function createLiminaCheckIssue(
  options: CreateLiminaCheckIssueOptions,
): CanonicalLiminaCheckIssue {
  const filePath = normalizeCheckIssuePath(options.rootDir, options.filePath);
  const packageManifestPath = normalizeCheckIssuePath(
    options.rootDir,
    options.packageManifestPath,
  );
  const explicitLocations =
    options.locations?.map((location) =>
      normalizeLocation(options.rootDir, location),
    ) ?? [];
  const fallbackLocations: LiminaCheckIssueLocation[] = [
    ...(filePath ? [{ filePath }] : []),
    ...(packageManifestPath ? [{ packageManifestPath }] : []),
  ];
  const locations =
    explicitLocations.length > 0
      ? explicitLocations
      : fallbackLocations.length > 0
        ? fallbackLocations
        : undefined;
  const code = options.code ?? defaultTaskFailureCode(options.task);
  assertWritableLiminaCheckIssueCode(code);
  assertIssueTaskMatchesCode(code, options.task);

  const issueWithoutId: Omit<CanonicalLiminaCheckIssue, 'id'> = {
    checkerName: options.checkerName,
    code,
    detailLines: options.detailLines ? [...options.detailLines] : undefined,
    detector: options.detector,
    domain: options.domain ?? inferDomain(options.task),
    evidence: normalizeEvidence(options.evidence),
    external: options.external,
    filePath,
    fix: options.fix,
    fixSteps: options.fixSteps ? [...options.fixSteps] : undefined,
    locations,
    packageManifestPath,
    packageName: options.packageName,
    reason: options.reason ?? `${options.task} finished with failures.`,
    scope: deriveCheckIssueScope({
      filePath,
      locations,
      packageManifestPath,
      scope: options.scope
        ? normalizeSlashes(options.scope.replaceAll(/^\.\//gu, ''))
        : undefined,
    }),
    severity: options.severity ?? 'error',
    summary: options.summary,
    task: options.task,
    title: options.title ?? `${options.task} failed`,
    tool: options.tool ?? options.external?.tool,
    verifyCommands: options.verifyCommands
      ? [...options.verifyCommands]
      : undefined,
  };

  return {
    ...issueWithoutId,
    id: options.id ?? createIssueId(issueWithoutId),
  };
}
