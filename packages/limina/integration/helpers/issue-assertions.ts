import type { LiminaCheckIssue } from '../../src/check-reporting/snapshot';
import { normalizeCheckIssuePath } from '../../src/check-reporting/structured';
import type {
  DetectorFixtureExpectation,
  ExpectedEvidence,
  ExpectedIssue,
  ExpectedLocation,
} from './detector-fixture-types';

interface IssueAssertionOptions {
  readonly actualIssues: readonly LiminaCheckIssue[];
  readonly expected: DetectorFixtureExpectation;
  readonly fixtureId: string;
  readonly repoRoot: string;
}

function normalizeIssuePath(
  repoRoot: string,
  value: string | undefined,
): string | undefined {
  return normalizeCheckIssuePath(repoRoot, value);
}

function evidenceMatches(
  expected: ExpectedEvidence,
  actual: NonNullable<LiminaCheckIssue['evidence']>[number],
): boolean {
  if (expected.label !== undefined && actual.label !== expected.label) {
    return false;
  }
  if (expected.value !== undefined && actual.value !== expected.value) {
    return false;
  }
  if (
    expected.lines !== undefined &&
    !expected.lines.every((line) => actual.lines?.includes(line))
  ) {
    return false;
  }

  return true;
}

function expectedEvidenceMatches(
  expected: readonly ExpectedEvidence[] | undefined,
  actual:
    | readonly NonNullable<LiminaCheckIssue['evidence']>[number][]
    | undefined,
): boolean {
  return (
    expected === undefined ||
    expected.every((expectedItem) =>
      actual?.some((actualItem) => evidenceMatches(expectedItem, actualItem)),
    )
  );
}

function locationMatches(
  expected: ExpectedLocation,
  actual: NonNullable<LiminaCheckIssue['locations']>[number],
  repoRoot: string,
): boolean {
  return (
    (expected.column === undefined || actual.column === expected.column) &&
    (expected.filePath === undefined ||
      normalizeIssuePath(repoRoot, actual.filePath) === expected.filePath) &&
    (expected.label === undefined || actual.label === expected.label) &&
    (expected.line === undefined || actual.line === expected.line) &&
    (expected.packageManifestPath === undefined ||
      normalizeIssuePath(repoRoot, actual.packageManifestPath) ===
        expected.packageManifestPath) &&
    (expected.scope === undefined || actual.scope === expected.scope)
  );
}

function locationConstraintCount(location: ExpectedLocation): number {
  return Object.values(location).filter((entry) => entry !== undefined).length;
}

function expectedLocationsMatch(
  expected: readonly ExpectedLocation[] | undefined,
  actual:
    | readonly NonNullable<LiminaCheckIssue['locations']>[number][]
    | undefined,
  repoRoot: string,
): boolean {
  if (expected === undefined) {
    return true;
  }

  const available = new Map(
    actual?.map((location, index) => [index, location]),
  );
  const expectedInMatchOrder = [...expected].sort(
    (left, right) =>
      locationConstraintCount(right) - locationConstraintCount(left),
  );

  for (const expectedLocation of expectedInMatchOrder) {
    const match = [...available].find(([, actualLocation]) =>
      locationMatches(expectedLocation, actualLocation, repoRoot),
    );
    if (match === undefined) {
      return false;
    }
    available.delete(match[0]);
  }

  return true;
}

function issueMatches(
  expected: ExpectedIssue,
  actual: LiminaCheckIssue,
  repoRoot: string,
): boolean {
  return (
    actual.code === expected.code &&
    actual.task === expected.task &&
    (expected.filePath === undefined ||
      normalizeIssuePath(repoRoot, actual.filePath) === expected.filePath) &&
    expectedLocationsMatch(expected.locations, actual.locations, repoRoot) &&
    (expected.packageManifestPath === undefined ||
      normalizeIssuePath(repoRoot, actual.packageManifestPath) ===
        expected.packageManifestPath) &&
    (expected.packageName === undefined ||
      actual.packageName === expected.packageName) &&
    (expected.reason === undefined || actual.reason === expected.reason) &&
    (expected.scope === undefined || actual.scope === expected.scope) &&
    (expected.checkerName === undefined ||
      actual.checkerName === expected.checkerName) &&
    (expected.externalCode === undefined ||
      actual.external?.code === expected.externalCode) &&
    expectedEvidenceMatches(expected.evidence, actual.evidence)
  );
}

function expectedConstraintCount(expected: ExpectedIssue): number {
  return (
    2 +
    Number(expected.filePath !== undefined) +
    (expected.locations?.reduce(
      (count, location) => count + locationConstraintCount(location),
      0,
    ) ?? 0) +
    Number(expected.packageManifestPath !== undefined) +
    Number(expected.packageName !== undefined) +
    Number(expected.reason !== undefined) +
    Number(expected.scope !== undefined) +
    Number(expected.checkerName !== undefined) +
    Number(expected.externalCode !== undefined) +
    (expected.evidence?.reduce(
      (count, evidence) =>
        count +
        Number(evidence.label !== undefined) +
        Number(evidence.value !== undefined) +
        (evidence.lines?.length ?? 0),
      0,
    ) ?? 0)
  );
}

export function formatExpectedIssueSummary(issue: ExpectedIssue): string {
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

export function formatActualIssueSummary(
  issue: LiminaCheckIssue,
  repoRoot: string,
): string {
  return JSON.stringify({
    checkerName: issue.checkerName,
    code: issue.code,
    externalCode: issue.external?.code,
    filePath: normalizeIssuePath(repoRoot, issue.filePath),
    locations: issue.locations?.map((location) => ({
      ...location,
      filePath: normalizeIssuePath(repoRoot, location.filePath),
      packageManifestPath: normalizeIssuePath(
        repoRoot,
        location.packageManifestPath,
      ),
    })),
    packageManifestPath: normalizeIssuePath(
      repoRoot,
      issue.packageManifestPath,
    ),
    packageName: issue.packageName,
    reason: issue.reason,
    scope: issue.scope,
    task: issue.task,
  });
}

function formatIssueList(
  issues: readonly LiminaCheckIssue[],
  repoRoot: string,
): string[] {
  const visible = issues
    .slice(0, 20)
    .map((issue) => `- ${formatActualIssueSummary(issue, repoRoot)}`);
  const omitted = issues.length - visible.length;

  return [
    ...visible,
    ...(omitted > 0 ? [`- ... ${omitted} more issues omitted`] : []),
  ];
}

export function assertDetectorIssues(options: IssueAssertionOptions): void {
  const available = new Map(
    options.actualIssues.map((issue, index) => [index, issue]),
  );
  const expectedInMatchOrder = options.expected.issues
    .map((issue, declarationIndex) => ({ declarationIndex, issue }))
    .sort(
      (left, right) =>
        expectedConstraintCount(right.issue) -
          expectedConstraintCount(left.issue) ||
        left.declarationIndex - right.declarationIndex,
    );

  for (const expectedEntry of expectedInMatchOrder) {
    const candidates = [...available.entries()].filter(([, actual]) =>
      issueMatches(expectedEntry.issue, actual, options.repoRoot),
    );
    if (candidates.length === 0) {
      throw new Error(
        [
          `Detector fixture ${options.fixtureId} is missing an expected issue.`,
          `expected: ${formatExpectedIssueSummary(expectedEntry.issue)}`,
          'remaining actual issues:',
          ...formatIssueList([...available.values()], options.repoRoot),
        ].join('\n'),
      );
    }
    if (candidates.length > 1) {
      throw new Error(
        [
          `Detector fixture ${options.fixtureId} has an ambiguous expected issue.`,
          `expected: ${formatExpectedIssueSummary(expectedEntry.issue)}`,
          'matching actual issues:',
          ...formatIssueList(
            candidates.map(([, issue]) => issue),
            options.repoRoot,
          ),
          'Add a stable location, package, checker, external code, or evidence constraint.',
        ].join('\n'),
      );
    }

    available.delete(candidates[0]![0]);
  }

  if (
    options.expected.primaryCode !== undefined &&
    !options.actualIssues.some(
      (issue) => issue.code === options.expected.primaryCode,
    )
  ) {
    throw new Error(
      `Detector fixture ${options.fixtureId} did not produce primary code ${options.expected.primaryCode}.`,
    );
  }

  const additionalCodes = new Set<string>(options.expected.additionalCodes);
  const unexpected = [...available.values()].filter(
    (issue) => !additionalCodes.has(issue.code),
  );
  if (
    unexpected.length > 0 &&
    options.expected.allowUnexpectedIssues !== true
  ) {
    throw new Error(
      [
        `Detector fixture ${options.fixtureId} produced undeclared issues.`,
        ...formatIssueList(unexpected, options.repoRoot),
      ].join('\n'),
    );
  }
}
