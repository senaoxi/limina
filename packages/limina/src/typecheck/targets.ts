import { getCheckerAdapter } from '#checkers';
import type {
  CheckerExecutionKind,
  ResolvedCheckerConfig,
} from '#config/runner';
import { normalizeSlashes, toRelativePath } from '#utils/path';
import { prependPathEntry, shouldUseShellForCommand } from '#utils/process';
import path from 'pathe';
import { runCheckerSpawnMeasured } from './process-host';
import {
  createCheckerTargetId,
  type TypecheckRunner,
  type TypecheckRunnerResult,
  type TypecheckTarget,
  type TypecheckTargetResult,
} from './target-types';

export {
  collectCheckerPeerDependencyProblems,
  getExecutionCheckers,
} from './checker-target-resolution';
export {
  checkerTargetId,
  createCheckerTargetId,
  toCheckerTargetOutcome,
  type CheckerTargetId,
  type CheckerTargetOutcome,
  type TypecheckRunner,
  type TypecheckRunnerResult,
  type TypecheckTarget,
  type TypecheckTargetResult,
} from './target-types';
export {
  collectVueTsgoConfigPaths,
  createVueTsgoCachePaths,
  findNearestPackageDir,
  isVueTsgoCommand,
} from './vue-tsgo-targets';

type CheckerProcessStdio = 'ignore' | 'inherit';

export function createCheckerTarget(options: {
  checker: ResolvedCheckerConfig;
  commandOverride?: string;
  configPath: string;
  executionKind: CheckerExecutionKind;
  projectRootDir: string;
  sourceConfigPath?: string;
  watch?: boolean;
}): TypecheckTarget {
  const adapter = getCheckerAdapter(options.checker.preset);

  if (adapter === null) {
    throw new Error(
      `Checker "${options.checker.name}" uses unsupported preset "${options.checker.preset}".`,
    );
  }

  const commandTarget = adapter.createCommandTarget(options);
  const sourceConfigPath = options.sourceConfigPath ?? options.configPath;
  const portableSourceConfigPath = normalizeSlashes(
    toRelativePath(options.projectRootDir, sourceConfigPath),
  );
  const portableConfigPath = normalizeSlashes(
    toRelativePath(options.projectRootDir, options.configPath),
  );

  return {
    ...commandTarget,
    checkerName: options.checker.name,
    configPath: options.configPath,
    cwd: options.projectRootDir,
    executionKind: options.executionKind,
    id: createCheckerTargetId([
      'checker-target',
      options.executionKind,
      options.checker.name,
      portableSourceConfigPath,
      portableConfigPath,
    ]),
    sourceConfigPath,
  };
}

function createCheckerProcessEnvironment(
  target: TypecheckTarget,
): NodeJS.ProcessEnv {
  return prependPathEntry(
    process.env,
    path.join(target.cwd, 'node_modules/.bin'),
  );
}

function resolveProcessStdio(options: {
  stdio?: CheckerProcessStdio;
}): CheckerProcessStdio {
  return options.stdio === undefined ? 'inherit' : options.stdio;
}

function createRunnerResult(options: {
  configPath: string;
  durationMs: number;
  error: Error | undefined;
  status: number;
}): TypecheckRunnerResult {
  return {
    configPath: options.configPath,
    durationMs: options.durationMs,
    ...(options.error === undefined ? {} : { error: options.error }),
    status: options.status,
  };
}

export function createDefaultRunner(
  options: {
    onDegraded?: (reason: string) => void;
    stdio?: CheckerProcessStdio;
  } = {},
): TypecheckRunner {
  const stdio = resolveProcessStdio(options);

  return async (target) => {
    const measurement = await runCheckerSpawnMeasured(
      {
        args: target.args,
        command: target.command,
        cwd: target.cwd,
        env: createCheckerProcessEnvironment(target),
        shell: shouldUseShellForCommand(target.command),
        stdio,
      },
      { onDegraded: options.onDegraded },
    );

    return createRunnerResult({
      configPath: target.configPath,
      durationMs: measurement.durationMs,
      error: measurement.error,
      status: measurement.status,
    });
  };
}

/**
 * Wraps one runner invocation so its result always carries a duration. A
 * runner-reported duration wins because it can be measured next to the
 * checker process; the wall-clock fallback only covers custom runners and is
 * inflated by event-loop delay whenever the parent thread is blocked.
 */
export async function runTargetWithMeasuredDuration(
  runner: TypecheckRunner,
  target: TypecheckTarget,
): Promise<TypecheckTargetResult> {
  const startedAt = performance.now();
  const result = await runner(target);

  return {
    ...result,
    durationMs: result.durationMs ?? performance.now() - startedAt,
    id: target.id,
  };
}
