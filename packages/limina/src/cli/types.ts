import type { ResolvedLiminaConfig } from '#config/runner';
import type { GlobalQueryCommandContext } from '../check-reporting/standalone-invocation-command';
import type { LiminaPreflightManager } from '../preflight';
import type {
  LiminaCheckIssue,
  LiminaCheckTaskName,
} from '../source-check/snapshot';

export interface GlobalFlags {
  config?: string;
  configLoader?: string;
  mode?: string;
}

export interface PackageSelectionFlags {
  package?: string | string[];
}

export interface SourceIssueSelectionFlags extends PackageSelectionFlags {
  file?: string | string[];
  rule?: string | string[];
  scope?: string | string[];
  verbose?: boolean;
}

export interface CheckFlags extends GlobalFlags, SourceIssueSelectionFlags {
  checker?: string | string[];
  format?: string;
  invocation?: string;
  issues?: boolean;
  limit?: number | string;
  task?: string | string[];
}

export interface SourceFlags extends GlobalFlags, SourceIssueSelectionFlags {}

export interface PackageFlags extends GlobalFlags, PackageSelectionFlags {
  attwProfile?: string;
  tool?: string;
  verbose?: boolean;
}

export interface CheckerFlags extends GlobalFlags {
  '--'?: string[];
  preset?: string;
  verbose?: boolean;
  w?: boolean;
  watch?: boolean;
}

export interface BuildFlags extends GlobalFlags {
  '--'?: string[];
  preset?: string;
  raw?: boolean;
  verbose?: boolean;
  w?: boolean;
  watch?: boolean;
}

export interface GraphFlags extends GlobalFlags {
  output?: string;
  verbose?: boolean;
  view?: string;
}

export interface ProofFlags extends GlobalFlags {
  verbose?: boolean;
}

export interface InitFlags {
  yes?: boolean;
}

export type MigrationFlags = GlobalFlags;

export interface StandaloneIssueSession {
  command: string;
  commandContext: GlobalQueryCommandContext;
  config: ResolvedLiminaConfig;
  issues: LiminaCheckIssue[];
  preflight: LiminaPreflightManager;
  task: LiminaCheckTaskName;
  title: string;
}

export type RegisterStandaloneIssueSession = (
  session: StandaloneIssueSession,
) => void;
