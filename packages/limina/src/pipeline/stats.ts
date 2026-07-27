import { toRelativePath } from '#utils/path';
import type { LiminaCheckRunTaskStats } from '../check-reporting/run-recorder';
import { createCheckItemStats } from '../check-reporting/stats';
import type { TypecheckTargetResult } from '../typecheck/targets';
import type { CheckerTaskStatsInput } from './types';

function getProblemCount(problems: readonly string[] | undefined): number {
  return problems === undefined ? 1 : problems.length;
}

function getPreflightIssueCount(result: CheckerTaskStatsInput): number {
  if (result.passed) return 0;
  return Math.max(1, getProblemCount(result.problems));
}

function createPreflightStats(
  result: CheckerTaskStatsInput,
): LiminaCheckRunTaskStats {
  const total = result.passed ? 0 : 1;
  return {
    items: [
      createCheckItemStats({
        issues: getPreflightIssueCount(result),
        name: result.passed
          ? 'second-class checker entries'
          : 'checker dependency preflight',
        total,
      }),
    ],
    passed: 0,
    total,
  };
}

export function formatCheckerEntryName(
  projectRootDir: string,
  configPath: string,
): string {
  const relativePath = toRelativePath(projectRootDir, configPath);
  const checkerEntryMatch = /^\.limina\/tsconfig\/checkers\/([^/]+)\//u.exec(
    relativePath,
  );
  return checkerEntryMatch === null
    ? relativePath
    : `${checkerEntryMatch[1]} checker entry`;
}

function createTargetNameMap(
  result: CheckerTaskStatsInput,
): Map<string, string> {
  return new Map(
    result.targetResults.map((targetResult) => [
      targetResult.id,
      formatCheckerEntryName(result.projectRootDir, targetResult.configPath),
    ]),
  );
}

function getTargetStatus(
  targetResult: TypecheckTargetResult,
): 'failed' | 'passed' {
  return targetResult.status === 0 ? 'passed' : 'failed';
}

function createBlockedBy(options: {
  blockedBy: readonly string[];
  targetNamesById: ReadonlyMap<string, string>;
}): { id: string; name: string }[] {
  return options.blockedBy.map((id) => ({
    id,
    name: options.targetNamesById.get(id) ?? id,
  }));
}

function createTargetStatusFields(options: {
  targetNamesById: ReadonlyMap<string, string>;
  targetResult: TypecheckTargetResult;
}):
  | {
      blockedBy: { id: string; name: string }[];
      status: 'blocked';
    }
  | { status: 'failed' | 'passed' } {
  const blockedBy = options.targetResult.blockedBy;
  if (blockedBy === undefined) {
    return { status: getTargetStatus(options.targetResult) };
  }
  return {
    blockedBy: createBlockedBy({
      blockedBy,
      targetNamesById: options.targetNamesById,
    }),
    status: 'blocked',
  };
}

function createTargetStatsItem(options: {
  projectRootDir: string;
  targetNamesById: ReadonlyMap<string, string>;
  targetResult: TypecheckTargetResult;
}): NonNullable<LiminaCheckRunTaskStats['items']>[number] {
  const item = createCheckItemStats({
    durationMs: options.targetResult.durationMs,
    issues: options.targetResult.status === 0 ? 0 : 1,
    name: formatCheckerEntryName(
      options.projectRootDir,
      options.targetResult.configPath,
    ),
    total: 1,
  });
  return {
    ...item,
    id: options.targetResult.id,
    itemKind: 'checker-target',
    ...createTargetStatusFields(options),
  };
}

function countPassedTargets(
  targetResults: readonly TypecheckTargetResult[],
): number {
  return targetResults.filter((target) => target.status === 0).length;
}

export function createCheckerTaskStats(
  result: CheckerTaskStatsInput,
): LiminaCheckRunTaskStats {
  if (result.rootConfigPaths.length === 0) return createPreflightStats(result);
  const targetNamesById = createTargetNameMap(result);
  return {
    items: result.targetResults.map((targetResult) =>
      createTargetStatsItem({
        projectRootDir: result.projectRootDir,
        targetNamesById,
        targetResult,
      }),
    ),
    passed: countPassedTargets(result.targetResults),
    total: result.targetResults.length,
  };
}

export function createCommandTaskStats(options: {
  durationMs: number;
  passed: boolean;
}): LiminaCheckRunTaskStats {
  const passed = options.passed ? 1 : 0;
  return {
    items: [
      createCheckItemStats({
        durationMs: options.durationMs,
        issues: options.passed ? 0 : 1,
        name: 'command execution',
        total: 1,
      }),
    ],
    passed,
    total: 1,
  };
}
