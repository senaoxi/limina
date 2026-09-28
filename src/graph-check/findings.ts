import type { ResolvedLiminaConfig } from '#config/runner';
import {
  type CanonicalLiminaCheckIssue,
  createTaskFailureIssue,
} from '../check-reporting/snapshot';
import type { GraphFinding } from './finding-types';

export * from './finding-types';

function getPackageManifestPath(finding: GraphFinding): string | undefined {
  return 'packageManifestPath' in finding
    ? finding.packageManifestPath
    : undefined;
}

function getPackageName(finding: GraphFinding): string | undefined {
  return 'packageName' in finding ? finding.packageName : undefined;
}

export function createGraphCheckIssueFromFinding(options: {
  config: ResolvedLiminaConfig;
  finding: GraphFinding;
}): CanonicalLiminaCheckIssue {
  return createTaskFailureIssue({
    checkerName: options.finding.checkerName,
    code: options.finding.code,
    detailLines: options.finding.presentation.detailLines,
    evidence: options.finding.evidence,
    filePath: options.finding.filePath,
    fix: options.finding.presentation.fix,
    locations: options.finding.locations,
    packageManifestPath: getPackageManifestPath(options.finding),
    packageName: getPackageName(options.finding),
    reason: options.finding.presentation.reason,
    rootDir: options.config.rootDir,
    task: options.finding.task,
    title: options.finding.presentation.title,
  });
}

export function createGraphCheckIssuesFromFindings(options: {
  config: ResolvedLiminaConfig;
  findings: readonly GraphFinding[];
}): CanonicalLiminaCheckIssue[] {
  return options.findings.map((finding) =>
    createGraphCheckIssueFromFinding({
      config: options.config,
      finding,
    }),
  );
}
