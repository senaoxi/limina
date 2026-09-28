import { toRelativePath } from '#utils/path';
import {
  type CanonicalLiminaCheckIssue,
  createTaskFailureIssue,
} from '../../../check-reporting/snapshot';
import type { ReleaseFinding, ReleaseFindingSection } from './types';

const RELEASE_FINDING_SECTION_ORDER: readonly ReleaseFindingSection[] = [
  'tarball',
  'output-manifest',
  'source-link',
  'source-private',
  'source-workspace',
  'registry-content',
  'packed-lint',
  'packed-manifest',
];

function createIssueDetailLines(finding: ReleaseFinding): string[] {
  const firstLine =
    finding.presentation.problemLines[0] ?? finding.presentation.summary;
  return [
    finding.presentation.sectionTitle,
    `  - ${firstLine}`,
    ...finding.presentation.problemLines.slice(1),
  ];
}

export function createReleaseCheckIssueFromFinding(options: {
  readonly finding: ReleaseFinding;
  readonly rootDir: string;
}): CanonicalLiminaCheckIssue {
  const { finding } = options;

  return createTaskFailureIssue({
    code: finding.code,
    detailLines: createIssueDetailLines(finding),
    domain: 'release',
    evidence: finding.evidence,
    external: finding.external,
    filePath: finding.filePath,
    fix: 'Inspect the release check report, rebuild the package output, or adjust release metadata before publishing.',
    fixSteps: [
      'Inspect the release check section shown in this issue.',
      'Rebuild the package output or adjust release metadata for the failing section.',
      'Rerun the release check before publishing.',
    ],
    locations: finding.locations,
    packageManifestPath: finding.packageManifestPath,
    packageName: finding.packageName,
    reason: finding.reason,
    rootDir: options.rootDir,
    summary: finding.presentation.summary,
    task: finding.task,
    title: finding.presentation.title,
    tool: 'release',
    verifyCommands: ['limina release check'],
  });
}

export function createReleaseCheckIssuesFromFindings(options: {
  readonly findings: readonly ReleaseFinding[];
  readonly rootDir: string;
}): CanonicalLiminaCheckIssue[] {
  return options.findings.map((finding) =>
    createReleaseCheckIssueFromFinding({
      finding,
      rootDir: options.rootDir,
    }),
  );
}

function selectSectionFindings(
  findings: readonly ReleaseFinding[],
  section: ReleaseFindingSection,
): ReleaseFinding[] {
  return findings.filter((finding) => finding.presentation.section === section);
}

export function orderReleaseFindingsForPresentation(
  findings: readonly ReleaseFinding[],
): ReleaseFinding[] {
  return RELEASE_FINDING_SECTION_ORDER.flatMap((section) =>
    selectSectionFindings(findings, section),
  );
}

function appendFindingLines(lines: string[], finding: ReleaseFinding): void {
  const [firstLine = finding.presentation.summary, ...remainingLines] =
    finding.presentation.problemLines;
  lines.push(`  - ${firstLine}`, ...remainingLines);
}

function appendSection(
  lines: string[],
  findings: readonly ReleaseFinding[],
  section: ReleaseFindingSection,
): void {
  const sectionFindings = selectSectionFindings(findings, section);

  if (sectionFindings.length === 0) {
    return;
  }

  lines.push('', sectionFindings[0]!.presentation.sectionTitle);

  for (const finding of sectionFindings) {
    appendFindingLines(lines, finding);
  }
}

function appendPublishOrder(
  lines: string[],
  publishOrder: readonly string[] | undefined,
): void {
  if (publishOrder !== undefined && publishOrder.length > 1) {
    lines.push('', `Suggested publish order: ${publishOrder.join(' -> ')}`);
  }
}

export function formatReleaseFindings(options: {
  readonly findings: readonly ReleaseFinding[];
  readonly label: string;
  readonly outDir: string;
  readonly publishOrder?: readonly string[];
  readonly rootDir: string;
}): string {
  const lines = [
    `package release check failed for ${options.label}:`,
    `  output: ${toRelativePath(options.rootDir, options.outDir)}`,
  ];

  for (const section of RELEASE_FINDING_SECTION_ORDER) {
    appendSection(lines, options.findings, section);
  }

  appendPublishOrder(lines, options.publishOrder);
  return lines.join('\n');
}
