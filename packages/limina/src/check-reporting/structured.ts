import { normalizeSlashes } from '#utils/path';
import { createHash } from 'node:crypto';
import {
  assertIssueTaskMatchesCode,
  assertWritableLiminaCheckIssueCode,
  defaultTaskFailureCode,
  type LiminaWritableCheckIssueCode,
} from './codes';
import type {
  CanonicalLiminaCheckIssue,
  LiminaCheckIssueEvidence,
  LiminaCheckIssueExternal,
  LiminaCheckIssueLocation,
  LiminaCheckIssueSeverity,
  LiminaCheckTaskName,
} from './snapshot';
import {
  deriveCheckIssueScope,
  normalizeCheckIssueLocation,
  normalizeCheckIssuePath,
} from './structured-paths';

export {
  deriveCheckIssueScope,
  normalizeCheckIssuePath,
} from './structured-paths';

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
  semanticIdentity?: unknown;
  scope?: string;
  severity?: LiminaCheckIssueSeverity;
  summary?: string;
  task: LiminaCheckTaskName;
  title?: string;
  tool?: string;
  verifyCommands?: readonly string[];
}

function cloneOptionalArray<Value>(
  values: readonly Value[] | undefined,
): Value[] | undefined {
  return values === undefined ? undefined : [...values];
}

function normalizeEvidence(
  evidence: readonly LiminaCheckIssueEvidence[] | undefined,
): LiminaCheckIssueEvidence[] | undefined {
  if (!evidence?.length) {
    return undefined;
  }

  return evidence.map((item) => ({
    ...item,
    lines: cloneOptionalArray(item.lines),
  }));
}

function createIssueId(
  issue: Omit<CanonicalLiminaCheckIssue, 'id'>,
  semanticIdentity: unknown,
): string {
  const hash = createHash('sha1')
    .update(
      JSON.stringify({
        checkerName: issue.checkerName,
        code: issue.code,
        filePath: issue.filePath,
        locations: issue.locations,
        packageManifestPath: issue.packageManifestPath,
        packageName: issue.packageName,
        semanticIdentity,
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

function valueOrDefault<Value>(
  value: Value | undefined,
  fallback: Value,
): Value {
  return value === undefined ? fallback : value;
}

function createFallbackLocations(
  filePath: string | undefined,
  packageManifestPath: string | undefined,
): LiminaCheckIssueLocation[] {
  const locations: LiminaCheckIssueLocation[] = [];

  if (filePath !== undefined) {
    locations.push({ filePath });
  }

  if (packageManifestPath !== undefined) {
    locations.push({ packageManifestPath });
  }

  return locations;
}

function normalizeExplicitLocations(options: {
  locations: readonly LiminaCheckIssueLocation[] | undefined;
  rootDir: string;
}): LiminaCheckIssueLocation[] | undefined {
  return options.locations?.map((location) =>
    normalizeCheckIssueLocation(options.rootDir, location),
  );
}

function nonEmptyLocations(
  locations: LiminaCheckIssueLocation[],
): LiminaCheckIssueLocation[] | undefined {
  return locations.length > 0 ? locations : undefined;
}

function createIssueLocations(options: {
  filePath: string | undefined;
  locations: readonly LiminaCheckIssueLocation[] | undefined;
  packageManifestPath: string | undefined;
  rootDir: string;
}): LiminaCheckIssueLocation[] | undefined {
  const explicitLocations = normalizeExplicitLocations(options);

  if (explicitLocations !== undefined && explicitLocations.length > 0) {
    return explicitLocations;
  }

  return nonEmptyLocations(
    createFallbackLocations(options.filePath, options.packageManifestPath),
  );
}

function normalizeExplicitScope(scope: string | undefined): string | undefined {
  return scope === undefined
    ? undefined
    : normalizeSlashes(scope.replaceAll(/^\.\//gu, ''));
}

function resolveIssueTool(
  options: CreateLiminaCheckIssueOptions,
): string | undefined {
  return options.tool === undefined ? options.external?.tool : options.tool;
}

function createIssueWithoutId(
  options: CreateLiminaCheckIssueOptions,
  code: LiminaWritableCheckIssueCode,
): Omit<CanonicalLiminaCheckIssue, 'id'> {
  const filePath = normalizeCheckIssuePath(options.rootDir, options.filePath);
  const packageManifestPath = normalizeCheckIssuePath(
    options.rootDir,
    options.packageManifestPath,
  );
  const locations = createIssueLocations({
    filePath,
    locations: options.locations,
    packageManifestPath,
    rootDir: options.rootDir,
  });

  return {
    checkerName: options.checkerName,
    code,
    detailLines: cloneOptionalArray(options.detailLines),
    detector: options.detector,
    domain: valueOrDefault(options.domain, inferDomain(options.task)),
    evidence: normalizeEvidence(options.evidence),
    external: options.external,
    filePath,
    fix: options.fix,
    fixSteps: cloneOptionalArray(options.fixSteps),
    locations,
    packageManifestPath,
    packageName: options.packageName,
    reason: valueOrDefault(
      options.reason,
      `${options.task} finished with failures.`,
    ),
    scope: deriveCheckIssueScope({
      filePath,
      locations,
      packageManifestPath,
      scope: normalizeExplicitScope(options.scope),
    }),
    severity: valueOrDefault(options.severity, 'error'),
    summary: options.summary,
    task: options.task,
    title: valueOrDefault(options.title, `${options.task} failed`),
    tool: resolveIssueTool(options),
    verifyCommands: cloneOptionalArray(options.verifyCommands),
  };
}

export function createLiminaCheckIssue(
  options: CreateLiminaCheckIssueOptions,
): CanonicalLiminaCheckIssue {
  const code = valueOrDefault(
    options.code,
    defaultTaskFailureCode(options.task),
  );

  assertWritableLiminaCheckIssueCode(code);
  assertIssueTaskMatchesCode(code, options.task);

  const issueWithoutId = createIssueWithoutId(options, code);
  return {
    ...issueWithoutId,
    id: valueOrDefault(
      options.id,
      createIssueId(issueWithoutId, options.semanticIdentity),
    ),
  };
}
