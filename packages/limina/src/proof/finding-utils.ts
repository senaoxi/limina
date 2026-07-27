import type { ResolvedLiminaConfig } from '#config/runner';
import { shouldUseColor } from '#utils/reporting';
import type { CheckIssueReportOptions } from '../check-reporting/human';
import { formatCheckIssueHumanReport } from '../check-reporting/human';
import type {
  LiminaCheckIssue,
  LiminaCheckIssueEvidence,
  LiminaCheckIssueLocation,
} from '../check-reporting/snapshot';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import {
  createProofCheckIssuesFromFindings,
  createProofFinding,
  type ProofFinding,
  type ProofFindingFactsByCode,
  type ProofFindingForCode,
  type ProofSemanticIssueCode,
} from './findings';
import type { ProofPackageIdentity } from './runner-types';

export function collectProofReportIssues(options: {
  config: ResolvedLiminaConfig;
  findings: readonly ProofFinding[];
}): LiminaCheckIssue[] {
  return createProofCheckIssuesFromFindings({
    findings: options.findings,
    rootDir: options.config.rootDir,
  });
}

function resolveReportIssues(options: {
  config: ResolvedLiminaConfig;
  findings: readonly ProofFinding[];
  issues?: readonly LiminaCheckIssue[];
}): readonly LiminaCheckIssue[] {
  if (options.issues) {
    return options.issues;
  }

  return collectProofReportIssues(options);
}

function resolveReportCommand(report?: CheckIssueReportOptions): string {
  return report?.command ?? 'limina proof check';
}

export function formatProofFindingReport(options: {
  config: ResolvedLiminaConfig;
  findings: readonly ProofFinding[];
  issues?: readonly LiminaCheckIssue[];
  report?: CheckIssueReportOptions;
}): string {
  return formatCheckIssueHumanReport({
    color: shouldUseColor(),
    command: resolveReportCommand(options.report),
    issues: resolveReportIssues(options),
    title: 'Proof check summary',
    verbose: options.report?.verbose,
  });
}

export function getProofPackageIdentity(
  workspaceLookup: WorkspaceLookupIndex,
  filePath: string | undefined,
): ProofPackageIdentity {
  if (!filePath) {
    return {};
  }

  const owner = workspaceLookup.findOwnerForFile(filePath);

  if (!owner) {
    return {};
  }

  return {
    packageManifestPath: owner.packageJsonPath,
    packageName: owner.name,
  };
}

function resolveDiagnosticEvidence(
  evidence: readonly LiminaCheckIssueEvidence[] | undefined,
  detailLines: readonly string[],
): readonly LiminaCheckIssueEvidence[] {
  if (evidence) {
    return evidence;
  }

  return [{ label: 'diagnostic', lines: [...detailLines] }];
}

export function createProofDiagnosticFinding<
  Code extends ProofSemanticIssueCode,
>(options: {
  checkerName?: string;
  code: Code;
  detailLines: readonly string[];
  evidence?: readonly LiminaCheckIssueEvidence[];
  facts: ProofFindingFactsByCode[Code];
  filePath?: string;
  hint?: string;
  locations?: readonly LiminaCheckIssueLocation[];
  packageIdentity?: ProofPackageIdentity;
  reason: string;
  scope?: string;
  title: string;
}): ProofFindingForCode<Code> {
  const packageIdentity = options.packageIdentity ?? {};

  return createProofFinding({
    checkerName: options.checkerName,
    code: options.code,
    evidence: resolveDiagnosticEvidence(options.evidence, options.detailLines),
    facts: options.facts,
    filePath: options.filePath,
    hint: options.hint,
    locations: options.locations,
    packageManifestPath: packageIdentity.packageManifestPath,
    packageName: packageIdentity.packageName,
    presentation: {
      detailLines: options.detailLines,
      title: options.title,
    },
    reason: options.reason,
    scope: options.scope,
  } as Omit<ProofFindingForCode<Code>, 'task'>);
}
