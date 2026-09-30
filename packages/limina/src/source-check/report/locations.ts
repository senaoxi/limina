import { normalizeSlashes, toRelativePath } from '#utils/path';
import path from 'pathe';
import type { LiminaCheckIssueEvidence } from '../../check-reporting/snapshot';
import type { SourceStructuredIssue } from './types';

type StructuredLocation = NonNullable<
  SourceStructuredIssue['locations']
>[number];

function hasLocationValue(location: StructuredLocation): boolean {
  return (
    location.filePath !== undefined ||
    location.packageManifestPath !== undefined ||
    location.scope !== undefined
  );
}

function findStructuredLocation(
  issue: SourceStructuredIssue,
): StructuredLocation | undefined {
  return issue.locations === undefined
    ? undefined
    : issue.locations.find(hasLocationValue);
}

function getStructuredLocationValue(
  location: StructuredLocation,
): string | undefined {
  if (location.filePath !== undefined) return location.filePath;
  return location.packageManifestPath === undefined
    ? location.scope
    : location.packageManifestPath;
}

function formatLabeledLocation(options: {
  label: string | undefined;
  value: string | undefined;
}): string {
  return [options.label, options.value].filter(Boolean).join(': ');
}

function findFileLocation(
  issue: SourceStructuredIssue,
): StructuredLocation | undefined {
  return issue.locations === undefined
    ? undefined
    : issue.locations.find((location) => location.filePath !== undefined);
}

function findManifestLocation(
  issue: SourceStructuredIssue,
): StructuredLocation | undefined {
  return issue.locations === undefined
    ? undefined
    : issue.locations.find(
        (location) => location.packageManifestPath !== undefined,
      );
}

function getFileLocationPath(issue: SourceStructuredIssue): string | undefined {
  const location = findFileLocation(issue);
  return location === undefined ? undefined : location.filePath;
}

function getManifestLocationPath(
  issue: SourceStructuredIssue,
): string | undefined {
  const location = findManifestLocation(issue);
  return location === undefined ? undefined : location.packageManifestPath;
}

function getLocationFilePath(issue: SourceStructuredIssue): string | undefined {
  const candidates = [
    issue.filePath,
    issue.packageJsonPath,
    getFileLocationPath(issue),
    getManifestLocationPath(issue),
  ];
  return candidates.find((candidate) => candidate !== undefined);
}

function getIssueScopeOrTitle(issue: SourceStructuredIssue): string {
  return issue.scope === undefined ? issue.title : issue.scope;
}

export function getGenericSourceIssueLocation(
  issue: SourceStructuredIssue,
): string {
  const structuredLocation = findStructuredLocation(issue);
  if (structuredLocation !== undefined) {
    return formatLabeledLocation({
      label: structuredLocation.label,
      value: getStructuredLocationValue(structuredLocation),
    });
  }
  return getLocationFilePath(issue) ?? getIssueScopeOrTitle(issue);
}

export function formatSourceIssuePath(
  rootDirectory: string,
  filePath: string,
): string {
  return path.isAbsolute(filePath)
    ? toRelativePath(rootDirectory, filePath)
    : normalizeSlashes(filePath);
}

function getStructuredFilePath(
  location: StructuredLocation,
): string | undefined {
  return location.filePath ?? location.packageManifestPath;
}

function getDisplayLocationValue(options: {
  location: StructuredLocation;
  rootDir: string;
}): string | undefined {
  const filePath = getStructuredFilePath(options.location);
  return filePath === undefined
    ? options.location.scope
    : formatSourceIssuePath(options.rootDir, filePath);
}

function getDisplayStructuredLocation(options: {
  issue: SourceStructuredIssue;
  rootDir: string;
}): string | null {
  const location = findStructuredLocation(options.issue);
  if (location === undefined) return null;
  return formatLabeledLocation({
    label: location.label,
    value: getDisplayLocationValue({
      location,
      rootDir: options.rootDir,
    }),
  });
}

function getFallbackDisplayLocation(options: {
  issue: SourceStructuredIssue;
  rootDir: string;
}): string {
  const filePath = getLocationFilePath(options.issue);
  return filePath === undefined
    ? getIssueScopeOrTitle(options.issue)
    : formatSourceIssuePath(options.rootDir, filePath);
}

export function getGenericSourceIssueDisplayLocation(
  rootDirectory: string,
  issue: SourceStructuredIssue,
): string {
  const structured = getDisplayStructuredLocation({
    issue,
    rootDir: rootDirectory,
  });
  return (
    structured ?? getFallbackDisplayLocation({ issue, rootDir: rootDirectory })
  );
}

function formatEvidenceHeading(item: LiminaCheckIssueEvidence): string[] {
  const heading = formatLabeledLocation({
    label: item.label,
    value: item.value,
  });
  return heading.length === 0 ? [] : [`  - ${heading}`];
}

function formatEvidenceItem(item: LiminaCheckIssueEvidence): string[] {
  return [
    ...formatEvidenceHeading(item),
    ...(item.lines ?? []).map((line) => `    ${line}`),
  ];
}

export function formatSourceEvidence(
  evidence: readonly LiminaCheckIssueEvidence[] | undefined,
): string[] {
  return evidence === undefined || evidence.length === 0
    ? []
    : ['evidence:', ...evidence.flatMap(formatEvidenceItem)];
}
