import type {
  LiminaCheckIssue,
  LiminaCheckIssueEvidence,
  LiminaCheckIssueLocation,
} from '../snapshot';

function optionalString(value: string | undefined): string {
  return value === undefined ? '' : value;
}

function optionalNumber(value: number | undefined): number | null {
  return value === undefined ? null : value;
}

function optionalArray<T>(value: readonly T[] | undefined): readonly T[] {
  return value === undefined ? [] : value;
}

function createLocationFingerprint(
  location: LiminaCheckIssueLocation,
): readonly unknown[] {
  return [
    optionalString(location.label),
    optionalString(location.filePath),
    optionalString(location.packageManifestPath),
    optionalString(location.scope),
    optionalNumber(location.line),
    optionalNumber(location.column),
  ];
}

function createEvidenceFingerprint(
  evidence: LiminaCheckIssueEvidence,
): readonly unknown[] {
  return [
    optionalString(evidence.label),
    optionalString(evidence.value),
    optionalArray(evidence.lines),
  ];
}

function createExternalFingerprint(
  issue: LiminaCheckIssue,
): readonly unknown[] {
  const external = issue.external;
  if (external === undefined) return [];
  return [
    optionalString(external.code),
    optionalString(external.message),
    optionalString(external.tool),
    optionalString(external.url),
  ];
}

function createIssueIdentityFields(
  issue: LiminaCheckIssue,
): readonly unknown[] {
  return [
    optionalString(issue.id),
    issue.task,
    issue.code,
    issue.title,
    issue.reason,
    optionalString(issue.severity),
    optionalString(issue.summary),
    optionalString(issue.domain),
    optionalString(issue.detector),
    optionalString(issue.checkerName),
    optionalString(issue.tool),
    optionalString(issue.packageName),
    optionalString(issue.filePath),
    optionalString(issue.packageManifestPath),
    optionalString(issue.scope),
    optionalString(issue.fix),
  ];
}

function createIssueDetailFields(issue: LiminaCheckIssue): readonly unknown[] {
  return [
    optionalArray(issue.detailLines),
    optionalArray(issue.fixSteps),
    optionalArray(issue.verifyCommands),
    optionalArray(issue.locations).map(createLocationFingerprint),
    optionalArray(issue.evidence).map(createEvidenceFingerprint),
    createExternalFingerprint(issue),
  ];
}

export function createCanonicalIssueFingerprint(
  issue: LiminaCheckIssue,
): string {
  return JSON.stringify([
    ...createIssueIdentityFields(issue),
    ...createIssueDetailFields(issue),
  ]);
}
