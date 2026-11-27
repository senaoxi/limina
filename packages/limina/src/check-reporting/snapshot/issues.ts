import type { SourceCheckIssue } from '../../source-check/report';
import type { LiminaWritableCheckIssueCode } from '../codes';
import { createLiminaCheckIssue } from '../structured';
import type {
  CanonicalLiminaCheckIssue,
  LiminaCheckIssueEvidence,
  LiminaCheckIssueExternal,
  LiminaCheckIssueLocation,
  LiminaCheckIssueSeverity,
  LiminaCheckTaskName,
} from './types';

export function createTaskFailureIssue(options: {
  checkerName?: string;
  code?: LiminaWritableCheckIssueCode;
  detector?: string;
  detailLines?: readonly string[];
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
}): CanonicalLiminaCheckIssue {
  return createLiminaCheckIssue(options);
}

export function createSourceCheckIssue(options: {
  issue: SourceCheckIssue;
  rootDir: string;
}): CanonicalLiminaCheckIssue {
  return createLiminaCheckIssue({
    checkerName: options.issue.checkerName,
    code: options.issue.code,
    detailLines: options.issue.detailLines,
    detector: options.issue.detector,
    domain: 'source',
    evidence: options.issue.evidence,
    external: options.issue.external,
    filePath: options.issue.filePath,
    fix: options.issue.fix,
    fixSteps: options.issue.fixSteps,
    locations: options.issue.locations,
    packageManifestPath: options.issue.packageJsonPath,
    packageName: options.issue.ownerName,
    reason: options.issue.reason,
    rootDir: options.rootDir,
    scope: options.issue.scope,
    semanticIdentity: options.issue.facts,
    summary: options.issue.summary,
    task: options.issue.task,
    title: options.issue.title,
    tool: options.issue.tool,
    verifyCommands: options.issue.verifyCommands,
  });
}
