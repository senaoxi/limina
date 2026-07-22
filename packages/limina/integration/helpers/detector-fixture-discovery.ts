import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  assertIssueTaskMatchesCode,
  DEFAULT_ISSUE_CODE_BY_TASK,
  isLiminaCheckIssueCode,
  isWritableLiminaCheckIssueCode,
  type LiminaCheckIssueCode,
} from '../../src/check-reporting/codes';
import {
  LIMINA_CHECK_TASK_NAMES,
  type LiminaCheckRunResult,
  type LiminaCheckRunTaskStatus,
  type LiminaCheckTaskName,
} from '../../src/check-reporting/snapshot';
import {
  INTERNAL_RELEASE_REGISTRY_TIMEOUT_ENV,
  INTERNAL_RELEASE_REGISTRY_URL_ENV,
} from '../../src/package-check/release-registry-test-seam';
import {
  type DetectorFixtureDefinition,
  type DetectorFixtureExpectation,
  type ExpectedEvidence,
  type ExpectedFaultBoundary,
  type ExpectedFaultError,
  type ExpectedIssue,
  type ExpectedLocation,
  type ExpectedRegistryRequest,
  type ExpectedSnapshot,
  type ExpectedStreamOutput,
  FIXTURE_TOOL_NAMES,
  type FixtureCopyPolicy,
  type FixtureMutation,
  type FixtureSetupOperation,
  type FixtureToolName,
  type LocalRegistryDigestDeclaration,
  type LocalRegistryResponse,
  type LocalRegistryResponseBody,
  type LocalRegistryScenario,
} from './detector-fixture-types';
import {
  assertDistinctFaultInjectionTargets,
  validateFaultInjectionDefinition,
} from './fault-injection';
import { validatePortableRelativePath } from './fixture-paths';

const DEFINITION_KEYS = new Set([
  'allowedGeneratedPaths',
  'command',
  'copyPolicy',
  'environment',
  'expected',
  'fault',
  'id',
  'kind',
  'mutations',
  'registry',
  'secondaryFault',
  'setup',
  'tools',
]);
const EXPECTATION_KEYS = new Set([
  'additionalCodes',
  'allowUnexpectedIssues',
  'boundary',
  'error',
  'exitCode',
  'issues',
  'primaryCode',
  'runOutcome',
  'snapshot',
  'stderr',
  'stdout',
  'taskStates',
]);
const EXPECTED_ISSUE_KEYS = new Set([
  'checkerName',
  'code',
  'evidence',
  'externalCode',
  'filePath',
  'locations',
  'packageManifestPath',
  'packageName',
  'reason',
  'scope',
  'task',
]);
const EXPECTED_EVIDENCE_KEYS = new Set(['label', 'lines', 'value']);
const EXPECTED_LOCATION_KEYS = new Set([
  'column',
  'filePath',
  'label',
  'line',
  'packageManifestPath',
  'scope',
]);
const EXPECTED_SNAPSHOT_KEYS = new Set(['complete', 'expected']);
const EXPECTED_STREAM_KEYS = new Set(['linesInOrder']);
const EXPECTED_FAULT_BOUNDARY_KEYS = new Set([
  'cleanupDescriptorCount',
  'cleanupDirectoryDescriptorCount',
  'cleanupFileDescriptorCount',
  'cleanupGenerationCount',
  'cleanupResourcesRemoved',
  'flowCleanupAttempts',
  'flowCleanupCompleted',
  'flowResourcesClosed',
  'removedTempFiles',
  'tempCleanupAttempts',
  'tempCleanupCompleted',
]);
const EXPECTED_FAULT_BOUNDARY_NUMBER_KEYS = new Set([
  'cleanupDescriptorCount',
  'cleanupDirectoryDescriptorCount',
  'cleanupFileDescriptorCount',
  'cleanupGenerationCount',
  'cleanupResourcesRemoved',
  'flowCleanupAttempts',
  'removedTempFiles',
  'tempCleanupAttempts',
]);
const EXPECTED_FAULT_ERROR_KEYS = new Set(['code', 'expected', 'name']);
const COPY_POLICY_KEYS = new Set([
  'excludedNames',
  'includeBuildInfoFiles',
  'includeOutputDirectories',
]);
const RESERVED_ENVIRONMENT_KEYS = new Set([
  'HOME',
  INTERNAL_RELEASE_REGISTRY_TIMEOUT_ENV,
  INTERNAL_RELEASE_REGISTRY_URL_ENV,
  'LIMINA_PRESERVE_INTEGRATION_ARTIFACTS',
  'NODE_PATH',
  'NPM_CONFIG_CACHE',
  'PATH',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'XDG_CACHE_HOME',
]);
const LOCAL_REGISTRY_SCENARIO_KEYS = new Set([
  'expectedRequests',
  'metadata',
  'packageName',
  'requestTimeoutMs',
  'tarballs',
]);
const LOCAL_REGISTRY_RESPONSE_KEYS = new Set(['body', 'headers', 'status']);
const FIXTURE_ID_SEGMENT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const TASK_NAME_SET = new Set<string>(LIMINA_CHECK_TASK_NAMES);
const TOOL_NAME_SET = new Set<string>(FIXTURE_TOOL_NAMES);
const RUN_OUTCOME_SET = new Set<LiminaCheckRunResult>([
  'blocked',
  'failed',
  'not-run',
  'passed',
  'running',
]);
const TASK_STATE_SET = new Set<LiminaCheckRunTaskStatus>([
  'blocked',
  'failed',
  'passed',
  'planned',
  'running',
  'skipped',
]);
const TASK_FALLBACK_CODE_SET = new Set<string>(
  Object.values(DEFAULT_ISSUE_CODE_BY_TASK),
);

function comparePortableNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface DetectorFixtureCase {
  readonly casePath: string;
  readonly definition: DetectorFixtureDefinition;
  readonly directoryPath: string;
  readonly id: string;
  readonly repoSourceRoot: string;
}

export interface DiscoverDetectorFixturesOptions {
  readonly caseModules: ReadonlyMap<string, unknown>;
  readonly detectorRoot: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === null || prototype === Object.prototype;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  label: string,
): void {
  const unexpectedKeys = Object.keys(value).filter(
    (key) => !allowedKeys.has(key),
  );

  if (unexpectedKeys.length > 0) {
    throw new Error(
      `${label} contains unsupported fields: ${unexpectedKeys.sort().join(', ')}.`,
    );
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return value;
}

function optionalNonEmptyString(
  value: unknown,
  label: string,
): string | undefined {
  return value === undefined ? undefined : requireNonEmptyString(value, label);
}

function validateFixtureId(value: unknown, label: string): string {
  const id = requireNonEmptyString(value, label);
  validatePortableRelativePath(id, { label });

  if (
    !id.split('/').every((segment) => FIXTURE_ID_SEGMENT_PATTERN.test(segment))
  ) {
    throw new Error(
      `${label} must contain lowercase kebab-case path segments: ${id}`,
    );
  }

  return id;
}

function validateCanonicalCode(
  value: unknown,
  label: string,
): LiminaCheckIssueCode {
  const code = requireNonEmptyString(value, label);

  if (!isLiminaCheckIssueCode(code)) {
    throw new Error(`${label} is not a canonical Limina issue code: ${code}`);
  }

  return code;
}

function validateActiveCanonicalCode(
  value: unknown,
  label: string,
): LiminaCheckIssueCode {
  const code = validateCanonicalCode(value, label);

  if (!isWritableLiminaCheckIssueCode(code)) {
    throw new Error(`${label} is not an active Limina issue code: ${code}`);
  }

  return code;
}

function validateTaskName(value: unknown, label: string): LiminaCheckTaskName {
  const task = requireNonEmptyString(value, label);

  if (!TASK_NAME_SET.has(task)) {
    throw new Error(`${label} is not a Limina check task: ${task}`);
  }

  return task as LiminaCheckTaskName;
}

function validateStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array.`);
  }

  return value.map((entry, index) =>
    requireNonEmptyString(entry, `${label}[${index}]`),
  );
}

function validateEvidence(value: unknown, label: string): ExpectedEvidence {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  assertOnlyKeys(value, EXPECTED_EVIDENCE_KEYS, label);
  const evidence: ExpectedEvidence = {
    label: optionalNonEmptyString(value.label, `${label}.label`),
    lines:
      value.lines === undefined
        ? undefined
        : validateStringArray(value.lines, `${label}.lines`),
    value: optionalNonEmptyString(value.value, `${label}.value`),
  };

  if (
    evidence.label === undefined &&
    evidence.lines === undefined &&
    evidence.value === undefined
  ) {
    throw new Error(`${label} must constrain at least one evidence field.`);
  }

  return evidence;
}

function optionalPositiveInteger(
  value: unknown,
  label: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return value as number;
}

function validateLocation(value: unknown, label: string): ExpectedLocation {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  assertOnlyKeys(value, EXPECTED_LOCATION_KEYS, label);

  const location: ExpectedLocation = {
    column: optionalPositiveInteger(value.column, `${label}.column`),
    filePath:
      value.filePath === undefined
        ? undefined
        : validatePortableRelativePath(value.filePath, {
            label: `${label}.filePath`,
          }),
    label: optionalNonEmptyString(value.label, `${label}.label`),
    line: optionalPositiveInteger(value.line, `${label}.line`),
    packageManifestPath:
      value.packageManifestPath === undefined
        ? undefined
        : validatePortableRelativePath(value.packageManifestPath, {
            label: `${label}.packageManifestPath`,
          }),
    scope: optionalNonEmptyString(value.scope, `${label}.scope`),
  };

  if (Object.values(location).every((entry) => entry === undefined)) {
    throw new Error(`${label} must constrain at least one location field.`);
  }

  return location;
}

function validateExpectedIssue(value: unknown, label: string): ExpectedIssue {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  assertOnlyKeys(value, EXPECTED_ISSUE_KEYS, label);
  const code = validateActiveCanonicalCode(value.code, `${label}.code`);
  const task = validateTaskName(value.task, `${label}.task`);
  assertIssueTaskMatchesCode(code, task);

  const filePath =
    value.filePath === undefined
      ? undefined
      : validatePortableRelativePath(value.filePath, {
          label: `${label}.filePath`,
        });
  const packageManifestPath =
    value.packageManifestPath === undefined
      ? undefined
      : validatePortableRelativePath(value.packageManifestPath, {
          label: `${label}.packageManifestPath`,
        });

  return {
    checkerName: optionalNonEmptyString(
      value.checkerName,
      `${label}.checkerName`,
    ),
    code,
    evidence:
      value.evidence === undefined
        ? undefined
        : Array.isArray(value.evidence)
          ? value.evidence.map((entry, index) =>
              validateEvidence(entry, `${label}.evidence[${index}]`),
            )
          : (() => {
              throw new Error(`${label}.evidence must be an array.`);
            })(),
    externalCode: optionalNonEmptyString(
      value.externalCode,
      `${label}.externalCode`,
    ),
    filePath,
    locations:
      value.locations === undefined
        ? undefined
        : Array.isArray(value.locations) && value.locations.length > 0
          ? value.locations.map((entry, index) =>
              validateLocation(entry, `${label}.locations[${index}]`),
            )
          : (() => {
              throw new Error(`${label}.locations must be a non-empty array.`);
            })(),
    packageManifestPath,
    packageName: optionalNonEmptyString(
      value.packageName,
      `${label}.packageName`,
    ),
    reason: optionalNonEmptyString(value.reason, `${label}.reason`),
    scope: optionalNonEmptyString(value.scope, `${label}.scope`),
    task,
  };
}

function expectedIssueIdentity(issue: ExpectedIssue): string {
  return JSON.stringify({
    checkerName: issue.checkerName,
    code: issue.code,
    evidence: issue.evidence,
    externalCode: issue.externalCode,
    filePath: issue.filePath,
    locations: issue.locations,
    packageManifestPath: issue.packageManifestPath,
    packageName: issue.packageName,
    reason: issue.reason,
    scope: issue.scope,
    task: issue.task,
  });
}

function validateExpectedSnapshot(
  value: unknown,
  label: string,
): ExpectedSnapshot | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  assertOnlyKeys(value, EXPECTED_SNAPSHOT_KEYS, label);
  if (typeof value.expected !== 'boolean') {
    throw new TypeError(`${label}.expected must be boolean.`);
  }
  if (value.complete !== undefined && typeof value.complete !== 'boolean') {
    throw new Error(`${label}.complete must be boolean.`);
  }
  if (value.expected === false && value.complete !== undefined) {
    throw new Error(`${label}.complete requires an expected snapshot.`);
  }

  return {
    complete: value.complete as boolean | undefined,
    expected: value.expected,
  };
}

function validateExpectedStream(
  value: unknown,
  label: string,
): ExpectedStreamOutput | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  assertOnlyKeys(value, EXPECTED_STREAM_KEYS, label);
  const linesInOrder =
    value.linesInOrder === undefined
      ? undefined
      : validateStringArray(value.linesInOrder, `${label}.linesInOrder`);
  if (linesInOrder === undefined || linesInOrder.length === 0) {
    throw new Error(`${label}.linesInOrder must be a non-empty array.`);
  }

  return { linesInOrder };
}

function validateExpectedFaultBoundary(
  value: unknown,
  label: string,
): ExpectedFaultBoundary | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  assertOnlyKeys(value, EXPECTED_FAULT_BOUNDARY_KEYS, label);
  const output: Record<string, boolean | number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (EXPECTED_FAULT_BOUNDARY_NUMBER_KEYS.has(key)) {
      if (!Number.isInteger(entry) || (entry as number) < 0) {
        throw new Error(`${label}.${key} must be a non-negative integer.`);
      }
      output[key] = entry as number;
    } else if (typeof entry === 'boolean') {
      output[key] = entry;
    } else {
      throw new TypeError(`${label}.${key} must be boolean.`);
    }
  }
  if (Object.keys(output).length === 0) {
    throw new Error(`${label} must constrain at least one boundary field.`);
  }
  return output as ExpectedFaultBoundary;
}

function validateExpectedFaultError(
  value: unknown,
  label: string,
): ExpectedFaultError | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  assertOnlyKeys(value, EXPECTED_FAULT_ERROR_KEYS, label);
  if (typeof value.expected !== 'boolean') {
    throw new TypeError(`${label}.expected must be boolean.`);
  }
  const code = optionalNonEmptyString(value.code, `${label}.code`);
  const name = optionalNonEmptyString(value.name, `${label}.name`);
  if (!value.expected && (code !== undefined || name !== undefined)) {
    throw new Error(`${label} cannot constrain an error that is not expected.`);
  }
  return { code, expected: value.expected, name };
}

function validateTaskStates(
  value: unknown,
  label: string,
):
  | Readonly<Partial<Record<LiminaCheckTaskName, LiminaCheckRunTaskStatus>>>
  | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be a task-state record.`);
  }
  const taskStates: Partial<
    Record<LiminaCheckTaskName, LiminaCheckRunTaskStatus>
  > = {};
  for (const [task, state] of Object.entries(value)) {
    if (!TASK_NAME_SET.has(task)) {
      throw new Error(`${label} contains an unsupported task: ${task}.`);
    }
    if (
      typeof state !== 'string' ||
      !TASK_STATE_SET.has(state as LiminaCheckRunTaskStatus)
    ) {
      throw new Error(`${label}.${task} is not a supported task state.`);
    }
    taskStates[task as LiminaCheckTaskName] = state as LiminaCheckRunTaskStatus;
  }
  if (Object.keys(taskStates).length === 0) {
    throw new Error(`${label} must constrain at least one task.`);
  }

  return taskStates;
}

function validateExpectation(
  value: unknown,
  label: string,
  options: { readonly faultInjection: boolean },
): DetectorFixtureExpectation {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  assertOnlyKeys(value, EXPECTATION_KEYS, label);
  if (
    !Number.isInteger(value.exitCode) ||
    (value.exitCode as number) < 0 ||
    (value.exitCode as number) > 255
  ) {
    throw new Error(`${label}.exitCode must be an integer from 0 through 255.`);
  }
  if (!Array.isArray(value.issues)) {
    throw new TypeError(`${label}.issues must be an array.`);
  }

  const issues = value.issues.map((issue, index) =>
    validateExpectedIssue(issue, `${label}.issues[${index}]`),
  );
  const identities = issues.map(expectedIssueIdentity);
  if (new Set(identities).size !== identities.length) {
    throw new Error(
      `${label}.issues contains indistinguishable duplicate expectations.`,
    );
  }
  const primaryCode =
    value.primaryCode === undefined
      ? undefined
      : validateActiveCanonicalCode(value.primaryCode, `${label}.primaryCode`);
  const exitCode = value.exitCode as number;

  if (exitCode === 0 && primaryCode !== undefined) {
    throw new Error(
      `${label}.primaryCode is not allowed for a passing fixture.`,
    );
  }
  if (exitCode !== 0 && primaryCode === undefined && !options.faultInjection) {
    throw new Error(`${label}.primaryCode is required for a failing fixture.`);
  }
  if (primaryCode && !issues.some((issue) => issue.code === primaryCode)) {
    throw new Error(
      `${label}.primaryCode must be represented by an expected issue.`,
    );
  }
  if (
    primaryCode &&
    TASK_FALLBACK_CODE_SET.has(primaryCode) &&
    !options.faultInjection
  ) {
    throw new Error(
      `${label}.primaryCode must be a semantic detector code, not a task fallback code: ${primaryCode}`,
    );
  }

  const additionalCodes =
    value.additionalCodes === undefined
      ? []
      : Array.isArray(value.additionalCodes)
        ? value.additionalCodes.map((code, index) =>
            validateActiveCanonicalCode(
              code,
              `${label}.additionalCodes[${index}]`,
            ),
          )
        : (() => {
            throw new Error(`${label}.additionalCodes must be an array.`);
          })();
  if (new Set(additionalCodes).size !== additionalCodes.length) {
    throw new Error(`${label}.additionalCodes must not contain duplicates.`);
  }
  const expectedCodes = new Set(issues.map((issue) => issue.code));
  const redundantCode = additionalCodes.find((code) => expectedCodes.has(code));
  if (redundantCode) {
    throw new Error(
      `${label}.additionalCodes must not repeat an explicitly expected code: ${redundantCode}`,
    );
  }
  if (
    value.allowUnexpectedIssues !== undefined &&
    typeof value.allowUnexpectedIssues !== 'boolean'
  ) {
    throw new Error(`${label}.allowUnexpectedIssues must be boolean.`);
  }

  const runOutcome =
    value.runOutcome === undefined
      ? undefined
      : typeof value.runOutcome === 'string' &&
          RUN_OUTCOME_SET.has(value.runOutcome as LiminaCheckRunResult)
        ? (value.runOutcome as LiminaCheckRunResult)
        : (() => {
            throw new Error(`${label}.runOutcome is unsupported.`);
          })();

  return {
    additionalCodes,
    allowUnexpectedIssues: value.allowUnexpectedIssues ?? false,
    boundary: validateExpectedFaultBoundary(
      value.boundary,
      `${label}.boundary`,
    ),
    error: validateExpectedFaultError(value.error, `${label}.error`),
    exitCode,
    issues,
    primaryCode,
    runOutcome,
    snapshot: validateExpectedSnapshot(value.snapshot, `${label}.snapshot`),
    stderr: validateExpectedStream(value.stderr, `${label}.stderr`),
    stdout: validateExpectedStream(value.stdout, `${label}.stdout`),
    taskStates: validateTaskStates(value.taskStates, `${label}.taskStates`),
  };
}

function validateCopyPolicy(
  value: unknown,
  label: string,
): FixtureCopyPolicy | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  assertOnlyKeys(value, COPY_POLICY_KEYS, label);

  for (const key of [
    'includeBuildInfoFiles',
    'includeOutputDirectories',
  ] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') {
      throw new Error(`${label}.${key} must be boolean.`);
    }
  }

  const excludedNames =
    value.excludedNames === undefined
      ? undefined
      : validateStringArray(value.excludedNames, `${label}.excludedNames`);
  for (const [index, entryName] of (excludedNames ?? []).entries()) {
    if (
      entryName === '.' ||
      entryName === '..' ||
      entryName.includes('/') ||
      entryName.includes('\\')
    ) {
      throw new Error(
        `${label}.excludedNames[${index}] must be a single entry name: ${entryName}`,
      );
    }
  }

  return {
    excludedNames,
    includeBuildInfoFiles: value.includeBuildInfoFiles as boolean | undefined,
    includeOutputDirectories: value.includeOutputDirectories as
      | boolean
      | undefined,
  };
}

function validateSetupOperation(
  value: unknown,
  label: string,
): FixtureSetupOperation {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const kind = requireNonEmptyString(value.kind, `${label}.kind`);
  const fixturePath = validatePortableRelativePath(value.path, {
    label: `${label}.path`,
  });

  if (kind === 'directory-link') {
    assertOnlyKeys(value, new Set(['kind', 'path', 'target']), label);
    return {
      kind,
      path: fixturePath,
      target: validatePortableRelativePath(value.target, {
        label: `${label}.target`,
      }),
    };
  }
  if (kind === 'write-file') {
    assertOnlyKeys(
      value,
      new Set(['content', 'kind', 'overwrite', 'path']),
      label,
    );
    if (typeof value.content !== 'string') {
      throw new TypeError(`${label}.content must be a string.`);
    }
    if (value.overwrite !== undefined && typeof value.overwrite !== 'boolean') {
      throw new Error(`${label}.overwrite must be boolean.`);
    }
    return {
      content: value.content,
      kind,
      overwrite: value.overwrite,
      path: fixturePath,
    };
  }
  if (kind === 'remove-path') {
    assertOnlyKeys(value, new Set(['allowMissing', 'kind', 'path']), label);
    if (
      value.allowMissing !== undefined &&
      typeof value.allowMissing !== 'boolean'
    ) {
      throw new Error(`${label}.allowMissing must be boolean.`);
    }
    return {
      allowMissing: value.allowMissing,
      kind,
      path: fixturePath,
    };
  }

  throw new Error(`${label}.kind is unsupported: ${kind}`);
}

function validateMutation(value: unknown, label: string): FixtureMutation {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const kind = requireNonEmptyString(value.kind, `${label}.kind`);
  const fixturePath = validatePortableRelativePath(value.path, {
    label: `${label}.path`,
  });

  if (kind === 'replace-text') {
    assertOnlyKeys(
      value,
      new Set(['all', 'kind', 'path', 'replacement', 'search']),
      label,
    );
    const search = requireNonEmptyString(value.search, `${label}.search`);
    if (typeof value.replacement !== 'string') {
      throw new TypeError(`${label}.replacement must be a string.`);
    }
    if (value.all !== undefined && typeof value.all !== 'boolean') {
      throw new Error(`${label}.all must be boolean.`);
    }
    return {
      all: value.all,
      kind,
      path: fixturePath,
      replacement: value.replacement,
      search,
    };
  }
  if (kind === 'write-file' || kind === 'remove-path') {
    return validateSetupOperation(value, label) as FixtureMutation;
  }

  throw new Error(`${label}.kind is unsupported: ${kind}`);
}

function validateEnvironment(
  value: unknown,
  label: string,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be a string record.`);
  }

  const environment: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (!key || typeof entryValue !== 'string') {
      throw new Error(`${label} must contain only string keys and values.`);
    }
    if (RESERVED_ENVIRONMENT_KEYS.has(key.toUpperCase())) {
      throw new Error(`${label} cannot override harness variable ${key}.`);
    }
    environment[key] = entryValue;
  }

  return environment;
}

function validateRegistryPathname(value: unknown, label: string): string {
  const pathname = requireNonEmptyString(value, label);
  if (
    !pathname.startsWith('/') ||
    pathname.startsWith('//') ||
    pathname.includes('\\') ||
    pathname.includes('?') ||
    pathname.includes('#')
  ) {
    throw new Error(
      `${label} must be an absolute URL pathname without query, fragment, or backslashes.`,
    );
  }

  const parsed = new URL(pathname, 'http://127.0.0.1');
  if (parsed.pathname !== pathname) {
    throw new Error(`${label} must already be URL-encoded: ${pathname}`);
  }

  return pathname;
}

function validateStringRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be a string record.`);
  }

  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!key || typeof entry !== 'string') {
      throw new Error(`${label} must contain only string keys and values.`);
    }
    output[key.toLowerCase()] = entry;
  }

  return output;
}

function validateJsonValue(value: unknown, label: string): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      validateJsonValue(entry, `${label}[${index}]`),
    );
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        validateJsonValue(entry, `${label}.${key}`),
      ]),
    );
  }

  throw new Error(`${label} must contain only JSON-safe values.`);
}

function validateRegistryDigest(
  value: unknown,
  label: string,
): LocalRegistryDigestDeclaration {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const kind = requireNonEmptyString(value.kind, `${label}.kind`);

  if (kind === 'value') {
    assertOnlyKeys(value, new Set(['kind', 'value']), label);
    return {
      kind,
      value: validateJsonValue(value.value, `${label}.value`),
    };
  }
  if (kind === 'actual' || kind === 'mismatch' || kind === 'omit') {
    assertOnlyKeys(value, new Set(['kind']), label);
    return { kind };
  }

  throw new Error(`${label}.kind is unsupported: ${kind}`);
}

function validateRegistryBody(
  value: unknown,
  label: string,
): LocalRegistryResponseBody {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const kind = requireNonEmptyString(value.kind, `${label}.kind`);

  if (kind === 'close-connection') {
    assertOnlyKeys(value, new Set(['kind']), label);
    return { kind };
  }
  if (kind === 'text' || kind === 'incomplete-body') {
    assertOnlyKeys(value, new Set(['kind', 'value']), label);
    if (typeof value.value !== 'string') {
      throw new TypeError(`${label}.value must be a string.`);
    }
    return { kind, value: value.value };
  }
  if (kind === 'bytes') {
    assertOnlyKeys(value, new Set(['kind', 'valueBase64']), label);
    const valueBase64 = requireNonEmptyString(
      value.valueBase64,
      `${label}.valueBase64`,
    );
    const decoded = Buffer.from(valueBase64, 'base64');
    if (decoded.toString('base64') !== valueBase64) {
      throw new Error(`${label}.valueBase64 must be canonical Base64.`);
    }
    return { kind, valueBase64 };
  }
  if (kind === 'json') {
    assertOnlyKeys(value, new Set(['kind', 'value']), label);
    return {
      kind,
      value: validateJsonValue(value.value, `${label}.value`),
    };
  }
  if (kind === 'delay') {
    assertOnlyKeys(value, new Set(['kind', 'milliseconds', 'next']), label);
    if (
      !Number.isSafeInteger(value.milliseconds) ||
      (value.milliseconds as number) < 1 ||
      (value.milliseconds as number) > 10_000
    ) {
      throw new Error(
        `${label}.milliseconds must be an integer from 1 through 10000.`,
      );
    }
    return {
      kind,
      milliseconds: value.milliseconds as number,
      next: validateRegistryBody(value.next, `${label}.next`),
    };
  }
  if (kind === 'package-tarball') {
    assertOnlyKeys(value, new Set(['files', 'kind']), label);
    if (!Array.isArray(value.files) || value.files.length === 0) {
      throw new Error(`${label}.files must be a non-empty array.`);
    }
    const files = value.files.map((file, index) => {
      const fileLabel = `${label}.files[${index}]`;
      if (!isPlainRecord(file)) {
        throw new Error(`${fileLabel} must be an object.`);
      }
      assertOnlyKeys(file, new Set(['content', 'path']), fileLabel);
      if (typeof file.content !== 'string') {
        throw new TypeError(`${fileLabel}.content must be a string.`);
      }
      return {
        content: file.content,
        path: validatePortableRelativePath(file.path, {
          label: `${fileLabel}.path`,
        }),
      };
    });
    if (new Set(files.map((file) => file.path)).size !== files.length) {
      throw new Error(`${label}.files must not contain duplicate paths.`);
    }
    return { files, kind };
  }
  if (kind === 'package-metadata') {
    assertOnlyKeys(
      value,
      new Set([
        'distTag',
        'integrity',
        'kind',
        'shasum',
        'tarballPath',
        'version',
      ]),
      label,
    );
    return {
      distTag: optionalNonEmptyString(value.distTag, `${label}.distTag`),
      integrity: validateRegistryDigest(value.integrity, `${label}.integrity`),
      kind,
      shasum:
        value.shasum === undefined
          ? undefined
          : validateRegistryDigest(value.shasum, `${label}.shasum`),
      tarballPath:
        value.tarballPath === undefined
          ? undefined
          : validateRegistryPathname(value.tarballPath, `${label}.tarballPath`),
      version: requireNonEmptyString(value.version, `${label}.version`),
    };
  }

  throw new Error(`${label}.kind is unsupported: ${kind}`);
}

function validateRegistryResponse(
  value: unknown,
  label: string,
): LocalRegistryResponse {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  assertOnlyKeys(value, LOCAL_REGISTRY_RESPONSE_KEYS, label);
  if (
    value.status !== undefined &&
    (!Number.isSafeInteger(value.status) ||
      (value.status as number) < 100 ||
      (value.status as number) > 599)
  ) {
    throw new Error(`${label}.status must be an HTTP status from 100 to 599.`);
  }

  return {
    body: validateRegistryBody(value.body, `${label}.body`),
    headers: validateStringRecord(value.headers, `${label}.headers`),
    status: value.status as number | undefined,
  };
}

function validateExpectedRegistryRequest(
  value: unknown,
  label: string,
): ExpectedRegistryRequest {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  assertOnlyKeys(value, new Set(['headers', 'method', 'pathname']), label);
  if (value.method !== undefined && value.method !== 'GET') {
    throw new Error(`${label}.method currently supports only GET.`);
  }

  return {
    headers: validateStringRecord(value.headers, `${label}.headers`),
    method: value.method as 'GET' | undefined,
    pathname: validateRegistryPathname(value.pathname, `${label}.pathname`),
  };
}

function validateRegistryScenario(
  value: unknown,
  label: string,
): LocalRegistryScenario | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  assertOnlyKeys(value, LOCAL_REGISTRY_SCENARIO_KEYS, label);
  if (!Array.isArray(value.expectedRequests)) {
    throw new TypeError(`${label}.expectedRequests must be an array.`);
  }

  const requestTimeoutMs = value.requestTimeoutMs;
  if (
    requestTimeoutMs !== undefined &&
    (!Number.isSafeInteger(requestTimeoutMs) ||
      (requestTimeoutMs as number) < 10 ||
      (requestTimeoutMs as number) > 10_000)
  ) {
    throw new Error(
      `${label}.requestTimeoutMs must be an integer from 10 through 10000.`,
    );
  }

  const tarballs: Record<string, LocalRegistryResponse> = {};
  if (value.tarballs !== undefined) {
    if (!isPlainRecord(value.tarballs)) {
      throw new Error(`${label}.tarballs must be a response record.`);
    }
    for (const [pathnameValue, response] of Object.entries(value.tarballs)) {
      const pathname = validateRegistryPathname(
        pathnameValue,
        `${label}.tarballs key`,
      );
      tarballs[pathname] = validateRegistryResponse(
        response,
        `${label}.tarballs[${JSON.stringify(pathname)}]`,
      );
    }
  }

  const metadata = validateRegistryResponse(
    value.metadata,
    `${label}.metadata`,
  );
  if (
    metadata.body.kind === 'package-metadata' &&
    metadata.body.tarballPath !== undefined &&
    tarballs[metadata.body.tarballPath] === undefined
  ) {
    throw new Error(
      `${label}.metadata references an undeclared tarball path: ${metadata.body.tarballPath}`,
    );
  }

  return {
    expectedRequests: value.expectedRequests.map((request, index) =>
      validateExpectedRegistryRequest(
        request,
        `${label}.expectedRequests[${index}]`,
      ),
    ),
    metadata,
    packageName: requireNonEmptyString(
      value.packageName,
      `${label}.packageName`,
    ),
    requestTimeoutMs: requestTimeoutMs as number | undefined,
    tarballs,
  };
}

function validateAllowedGeneratedPaths(
  value: unknown,
  label: string,
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const patterns = validateStringArray(value, label).map((pattern, index) =>
    validatePortableRelativePath(pattern, {
      allowGlob: true,
      label: `${label}[${index}]`,
    }),
  );

  for (const pattern of patterns) {
    if (
      pattern === '*' ||
      pattern === '**' ||
      pattern === '**/*' ||
      pattern.startsWith('**/')
    ) {
      throw new Error(`${label} contains an over-broad pattern: ${pattern}`);
    }
  }

  return patterns;
}

export function validateDetectorFixtureDefinition(
  value: unknown,
  options: { readonly casePath: string; readonly expectedId?: string },
): DetectorFixtureDefinition {
  const label = `Detector fixture declaration in ${options.casePath}`;
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must default-export an object.`);
  }
  assertOnlyKeys(value, DEFINITION_KEYS, label);
  const id = validateFixtureId(value.id, `${label}.id`);

  if (options.expectedId !== undefined && id !== options.expectedId) {
    throw new Error(
      `${label} has an ID/directory mismatch: declared "${id}", expected "${options.expectedId}".`,
    );
  }
  if (
    value.kind !== 'filesystem' &&
    value.kind !== 'external-tool' &&
    value.kind !== 'fault-injection'
  ) {
    throw new Error(`${label}.kind is unsupported: ${String(value.kind)}`);
  }
  const faultInjection = value.kind === 'fault-injection';
  if (faultInjection && value.fault === undefined) {
    throw new Error(`${label}.fault is required for fault-injection fixtures.`);
  }
  if (!faultInjection && value.fault !== undefined) {
    throw new Error(
      `${label}.fault is only valid for fault-injection fixtures.`,
    );
  }
  if (!faultInjection && value.secondaryFault !== undefined) {
    throw new Error(
      `${label}.secondaryFault is only valid for fault-injection fixtures.`,
    );
  }
  const fault =
    value.fault === undefined
      ? undefined
      : validateFaultInjectionDefinition(value.fault, `${label}.fault`);
  const secondaryFault =
    value.secondaryFault === undefined
      ? undefined
      : validateFaultInjectionDefinition(
          value.secondaryFault,
          `${label}.secondaryFault`,
        );
  if (fault) {
    assertDistinctFaultInjectionTargets(fault, secondaryFault, label);
  }
  const command = validateStringArray(value.command, `${label}.command`);
  if (command.length === 0) {
    throw new Error(`${label}.command must contain at least one CLI argument.`);
  }
  if (command[0]!.startsWith('-')) {
    throw new Error(`${label}.command must start with a Limina subcommand.`);
  }

  const setup =
    value.setup === undefined
      ? []
      : Array.isArray(value.setup)
        ? value.setup.map((operation, index) =>
            validateSetupOperation(operation, `${label}.setup[${index}]`),
          )
        : (() => {
            throw new Error(`${label}.setup must be an array.`);
          })();
  const mutations =
    value.mutations === undefined
      ? []
      : Array.isArray(value.mutations)
        ? value.mutations.map((mutation, index) =>
            validateMutation(mutation, `${label}.mutations[${index}]`),
          )
        : (() => {
            throw new Error(`${label}.mutations must be an array.`);
          })();
  const tools =
    value.tools === undefined
      ? []
      : Array.isArray(value.tools)
        ? value.tools.map((tool, index) => {
            const name = requireNonEmptyString(
              tool,
              `${label}.tools[${index}]`,
            );
            if (!TOOL_NAME_SET.has(name)) {
              throw new Error(
                `${label}.tools[${index}] is unsupported: ${name}`,
              );
            }
            return name as FixtureToolName;
          })
        : (() => {
            throw new Error(`${label}.tools must be an array.`);
          })();
  if (new Set(tools).size !== tools.length) {
    throw new Error(`${label}.tools must not contain duplicates.`);
  }
  const registry = validateRegistryScenario(
    value.registry,
    `${label}.registry`,
  );
  if (registry !== undefined && value.kind !== 'external-tool') {
    throw new Error(
      `${label}.kind must be external-tool when a local registry scenario is declared.`,
    );
  }

  return {
    allowedGeneratedPaths: validateAllowedGeneratedPaths(
      value.allowedGeneratedPaths,
      `${label}.allowedGeneratedPaths`,
    ),
    command,
    copyPolicy: validateCopyPolicy(value.copyPolicy, `${label}.copyPolicy`),
    environment: validateEnvironment(value.environment, `${label}.environment`),
    expected: validateExpectation(value.expected, `${label}.expected`, {
      faultInjection,
    }),
    fault,
    id,
    kind: value.kind,
    mutations,
    registry,
    secondaryFault,
    setup,
    tools,
  };
}

async function collectFixtureDirectories(
  currentDirectory: string,
  output: string[],
): Promise<void> {
  const entries = (
    await readdir(currentDirectory, { withFileTypes: true })
  ).sort((left, right) => comparePortableNames(left.name, right.name));
  const caseEntries = entries.filter((entry) => /^case\./u.test(entry.name));
  const repoEntry = entries.find((entry) => entry.name === 'repo');

  if (caseEntries.length > 0 || repoEntry) {
    if (
      caseEntries.length !== 1 ||
      caseEntries[0]!.name !== 'case.mts' ||
      !caseEntries[0]!.isFile()
    ) {
      throw new Error(
        `Detector fixture ${currentDirectory} must contain exactly one case.mts declaration.`,
      );
    }
    if (!repoEntry || !repoEntry.isDirectory() || repoEntry.isSymbolicLink()) {
      throw new Error(
        `Detector fixture ${currentDirectory} must contain a real repo directory.`,
      );
    }
    const repoPath = path.join(currentDirectory, 'repo');
    const repoStat = await lstat(repoPath);
    if (!repoStat.isDirectory() || repoStat.isSymbolicLink()) {
      throw new Error(
        `Detector fixture repo must be a real directory: ${repoPath}`,
      );
    }
    output.push(currentDirectory);
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Detector fixture discovery does not follow directory links: ${path.join(currentDirectory, entry.name)}`,
      );
    }
    await collectFixtureDirectories(
      path.join(currentDirectory, entry.name),
      output,
    );
  }
}

function readCaseModuleDefault(caseModule: unknown, casePath: string): unknown {
  if (!caseModule || typeof caseModule !== 'object') {
    throw new Error(
      `Detector case module did not load as a module: ${casePath}`,
    );
  }
  const moduleRecord = caseModule as Record<string, unknown>;
  const declarationExports = Object.keys(moduleRecord).filter(
    (key) => key !== '__esModule',
  );
  if (declarationExports.length !== 1 || declarationExports[0] !== 'default') {
    throw new Error(
      `Detector case module must expose only one default declaration: ${casePath}`,
    );
  }

  return moduleRecord.default;
}

export async function discoverDetectorFixtures(
  options: DiscoverDetectorFixturesOptions,
): Promise<readonly DetectorFixtureCase[]> {
  const detectorRoot = await realpath(options.detectorRoot);
  const fixtureDirectories: string[] = [];
  await collectFixtureDirectories(detectorRoot, fixtureDirectories);

  const modulesByPath = new Map(
    [...options.caseModules.entries()].map(([casePath, caseModule]) => [
      path.resolve(casePath),
      caseModule,
    ]),
  );
  const discovered = fixtureDirectories
    .map((directoryPath) => ({
      directoryPath,
      id: path.relative(detectorRoot, directoryPath).replaceAll('\\', '/'),
    }))
    .sort((left, right) => comparePortableNames(left.id, right.id))
    .map(({ directoryPath, id: directoryId }) => {
      const casePath = path.join(directoryPath, 'case.mts');
      const caseModule = modulesByPath.get(path.resolve(casePath));

      if (caseModule === undefined) {
        throw new Error(
          `Detector case declaration was discovered but not loaded by the test runner: ${casePath}`,
        );
      }

      return {
        casePath,
        definition: validateDetectorFixtureDefinition(
          readCaseModuleDefault(caseModule, casePath),
          { casePath },
        ),
        directoryId,
        directoryPath,
        repoSourceRoot: path.join(directoryPath, 'repo'),
      };
    });

  const fixtureIds = discovered.map((fixture) => fixture.definition.id);
  const duplicateId = fixtureIds.find(
    (id, index) => fixtureIds.indexOf(id) !== index,
  );
  if (duplicateId) {
    throw new Error(`Duplicate detector fixture ID: ${duplicateId}`);
  }

  const fixtures = discovered.map((fixture) => {
    if (fixture.definition.id !== fixture.directoryId) {
      throw new Error(
        `Detector fixture declaration in ${fixture.casePath} has an ID/directory mismatch: declared "${fixture.definition.id}", expected "${fixture.directoryId}".`,
      );
    }

    return {
      casePath: fixture.casePath,
      definition: fixture.definition,
      directoryPath: fixture.directoryPath,
      id: fixture.definition.id,
      repoSourceRoot: fixture.repoSourceRoot,
    } satisfies DetectorFixtureCase;
  });

  return fixtures;
}
