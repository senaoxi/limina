import { LIMINA_CHECK_ISSUE_CODES } from '../../check-reporting/codes';
import type {
  SourceFinding,
  SourceSemanticIssueCode,
  SourceStructuredFinding,
  SourceUnusedModuleFinding,
  SourceUnusedWorkspaceDependencyFinding,
} from '../findings';

export const SOURCE_ISSUE_CODES: {
  readonly unusedModule: typeof LIMINA_CHECK_ISSUE_CODES.sourceUnusedModule;
  readonly unusedWorkspaceDependency: typeof LIMINA_CHECK_ISSUE_CODES.sourceUnusedWorkspaceDependency;
} = {
  unusedModule: LIMINA_CHECK_ISSUE_CODES.sourceUnusedModule,
  unusedWorkspaceDependency:
    LIMINA_CHECK_ISSUE_CODES.sourceUnusedWorkspaceDependency,
};

export type SourceIssueCode = SourceSemanticIssueCode;

export interface SourceIssueReportOptions {
  command?: string;
  defer?: boolean;
  files?: readonly string[];
  packageNames?: readonly string[];
  rules?: readonly string[];
  scopes?: readonly string[];
  verbose?: boolean;
}

export type SourceUnusedModuleIssue = SourceUnusedModuleFinding;
export type SourceUnusedWorkspaceDependencyIssue =
  SourceUnusedWorkspaceDependencyFinding;
export type SourceStructuredIssue = SourceStructuredFinding;
export type SourceCheckIssue = SourceFinding;

export interface GenericSourceIssueGroup {
  issues: SourceStructuredIssue[];
  key: string;
}
