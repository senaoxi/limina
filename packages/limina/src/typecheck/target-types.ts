import { createHash } from 'node:crypto';

import type { CheckerDependencyRequirement } from '#checkers';
import type { CheckerExecutionKind } from '#config/runner';

declare const checkerTargetIdBrand: unique symbol;
export type CheckerTargetId = string & {
  readonly [checkerTargetIdBrand]: 'CheckerTargetId';
};

export function checkerTargetId(value: string): CheckerTargetId {
  if (!/^checker-target:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`Invalid checker target id: ${value}.`);
  }

  return value as CheckerTargetId;
}

export function createCheckerTargetId(
  identity: readonly string[],
): CheckerTargetId {
  return checkerTargetId(
    `checker-target:${createHash('sha256').update(identity.join('\0')).digest('hex')}`,
  );
}

export interface TypecheckTarget {
  args: string[];
  checkerFamily?: 'astro' | 'svelte';
  checkerName?: string;
  command: string;
  configPath: string;
  cwd: string;
  dependencyRequirements?: readonly CheckerDependencyRequirement[];
  dependencyRootDir?: string;
  executionRootDir?: string;
  executionKind?: CheckerExecutionKind;
  id: CheckerTargetId;
  label?: string;
  sourceConfigPath?: string;
  workspaceRootDir?: string;
}

export interface TypecheckTargetResult {
  blockedBy?: readonly CheckerTargetId[];
  configPath: string;
  durationMs: number;
  error?: Error;
  id: CheckerTargetId;
  status: number;
}

export type TypecheckRunnerResult = Omit<
  TypecheckTargetResult,
  'durationMs' | 'id'
> &
  Partial<Pick<TypecheckTargetResult, 'durationMs' | 'id'>>;

export type CheckerTargetOutcome =
  | {
      durationMs: number;
      id: CheckerTargetId;
      status: 'passed';
    }
  | {
      durationMs: number;
      error?: Error;
      exitCode: number;
      id: CheckerTargetId;
      status: 'failed';
    }
  | {
      blockedBy: readonly CheckerTargetId[];
      id: CheckerTargetId;
      status: 'blocked';
    };

export type TypecheckRunner = (
  target: TypecheckTarget,
  options?: { signal?: AbortSignal },
) => Promise<TypecheckRunnerResult> | TypecheckRunnerResult;

function assertMatchingTargetIdentity(
  target: TypecheckTarget,
  result: TypecheckTargetResult,
): void {
  if (result.id !== target.id) {
    throw new Error(
      `Checker target result identity mismatch for ${target.id}.`,
    );
  }
}

function createCompletedOutcome(
  result: TypecheckTargetResult,
): CheckerTargetOutcome {
  const durationMs = result.durationMs;

  return result.status === 0
    ? { durationMs, id: result.id, status: 'passed' }
    : {
        durationMs,
        ...(result.error === undefined ? {} : { error: result.error }),
        exitCode: result.status,
        id: result.id,
        status: 'failed',
      };
}

export function toCheckerTargetOutcome(
  target: TypecheckTarget,
  result: TypecheckTargetResult,
): CheckerTargetOutcome {
  assertMatchingTargetIdentity(target, result);

  if (result.blockedBy !== undefined) {
    return { blockedBy: result.blockedBy, id: result.id, status: 'blocked' };
  }

  return createCompletedOutcome(result);
}
