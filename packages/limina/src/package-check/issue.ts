import type { PackageCheckTool } from '#config/runner';
import type { LiminaWritableCheckIssueCode } from '../check-reporting/codes';
import type {
  LiminaCheckIssue,
  LiminaCheckIssueEvidence,
  LiminaCheckIssueExternal,
} from '../check-reporting/snapshot';
import { createTaskFailureIssue } from '../check-reporting/snapshot';
import { LiminaOptionalToolMissingError } from '../execution/tools';

function withDefault<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

export function createMissingPeerDependencyError(options: {
  command: string;
  error: unknown;
  packageName: string;
  toolName?: string;
}): Error {
  return new LiminaOptionalToolMissingError({
    command: options.command,
    error: options.error,
    packageName: options.packageName,
    toolName: options.toolName,
  });
}

export function addPackageCheckIssue(options: {
  code: LiminaWritableCheckIssueCode;
  detailLines?: readonly string[];
  evidence?: readonly LiminaCheckIssueEvidence[];
  external?: LiminaCheckIssueExternal;
  filePath?: string;
  fix: string;
  fixSteps?: readonly string[];
  issueSink?: LiminaCheckIssue[];
  packageManifestPath?: string;
  packageName?: string;
  reason: string;
  rootDir: string;
  summary?: string;
  title: string;
  tool: PackageCheckTool | 'manifest';
  verifyCommands?: readonly string[];
}): void {
  if (options.issueSink === undefined) return;
  options.issueSink.push(
    createTaskFailureIssue({
      code: options.code,
      detailLines: options.detailLines,
      domain: 'package',
      evidence: options.evidence,
      external: withDefault(options.external, { tool: options.tool }),
      filePath: options.filePath,
      fix: options.fix,
      fixSteps: withDefault(options.fixSteps, [options.fix]),
      packageManifestPath: options.packageManifestPath,
      packageName: options.packageName,
      reason: options.reason,
      rootDir: options.rootDir,
      summary: options.summary,
      task: 'package:check',
      title: options.title,
      tool: options.tool,
      verifyCommands: withDefault(options.verifyCommands, [
        'limina package check',
      ]),
    }),
  );
}
