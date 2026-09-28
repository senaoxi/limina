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
  collectCheckerPeerDependencyDetails,
  collectCheckerPeerDependencyProblems,
  getExecutionCheckers,
} from './checker-target-resolution';
export {
  collectFrameworkTargetPreflightFailures,
  type FrameworkTargetPreflightFailure,
} from './framework-target-preflight';
export {
  collectFrameworkCapabilityDescriptors,
  createFrameworkCheckerTarget,
  createFrameworkCheckerTargets,
} from './framework-targets';
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

type CheckerProcessStdio = 'ignore' | 'inherit';

function resolveDefaultPath(
  value: string | undefined,
  fallback: string,
): string {
  return value === undefined ? fallback : value;
}

function createCheckerDependencyRequirements(
  adapter: NonNullable<ReturnType<typeof getCheckerAdapter>>,
): NonNullable<TypecheckTarget['dependencyRequirements']> {
  if (adapter.dependencies === undefined) {
    throw new Error(
      `Checker adapter "${adapter.name}" has no dependency classification.`,
    );
  }
  return [
    ...adapter.dependencies.externalCheckerPackages.map((packageName) => ({
      category: 'external-checker' as const,
      packageName,
    })),
    ...adapter.dependencies.liminaRuntimePackages.map((packageName) => ({
      category: 'limina-runtime' as const,
      packageName,
    })),
  ];
}

export function createCheckerTarget(options: {
  checker: ResolvedCheckerConfig;
  commandOverride?: string;
  configPath: string;
  dependencyRootDir?: string;
  executionRootDir?: string;
  executionKind: CheckerExecutionKind;
  projectRootDir: string;
  sourceConfigPath?: string;
  watch?: boolean;
}): TypecheckTarget {
  const adapter = getCheckerAdapter(options.checker.name);

  if (adapter === null) {
    throw new Error(
      `Checker "${options.checker.name}" uses unsupported preset "${options.checker.name}".`,
    );
  }

  const commandTarget = adapter.createCommandTarget(options);
  const dependencyRootDir = resolveDefaultPath(
    options.dependencyRootDir,
    options.projectRootDir,
  );
  const executionRootDir = resolveDefaultPath(
    options.executionRootDir,
    options.projectRootDir,
  );
  const sourceConfigPath = resolveDefaultPath(
    options.sourceConfigPath,
    options.configPath,
  );
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
    cwd: executionRootDir,
    dependencyRequirements: createCheckerDependencyRequirements(adapter),
    dependencyRootDir,
    executionRootDir,
    executionKind: options.executionKind,
    id: createCheckerTargetId([
      'checker-target',
      options.executionKind,
      options.checker.name,
      options.checker.name,
      portableSourceConfigPath,
      portableConfigPath,
    ]),
    sourceConfigPath,
    workspaceRootDir: options.projectRootDir,
  };
}

function createCheckerProcessEnvironment(
  target: TypecheckTarget,
): NodeJS.ProcessEnv {
  const executionRootDir = resolveDefaultPath(
    target.executionRootDir,
    target.cwd,
  );
  return prependPathEntry(
    process.env,
    path.join(executionRootDir, 'node_modules/.bin'),
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

  return async (target, runOptions) => {
    const executionRootDir = resolveDefaultPath(
      target.executionRootDir,
      target.cwd,
    );
    const measurement = await runCheckerSpawnMeasured(
      {
        args: target.args,
        command: target.command,
        cwd: executionRootDir,
        env: createCheckerProcessEnvironment(target),
        shell: shouldUseShellForCommand(target.command),
        stdio,
      },
      { onDegraded: options.onDegraded, signal: runOptions?.signal },
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
  signal?: AbortSignal,
): Promise<TypecheckTargetResult> {
  const startedAt = performance.now();
  const result = await runner(target, { signal });

  return {
    ...result,
    durationMs: result.durationMs ?? performance.now() - startedAt,
    id: target.id,
  };
}
