import type { LiminaWritableCheckIssueCode } from '../../check-reporting/codes';
import { createLiminaCheckIssue } from '../../check-reporting/structured';
import { createSourceCheckIssueFromFinding } from '../findings';
import type { SourceCheckIssue } from '../report';
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
  return createSourceCheckIssueFromFinding({
    finding: options.issue,
    rootDir: options.rootDir,
  });
}
