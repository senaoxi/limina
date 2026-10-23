import { compareCodeUnits } from '#utils/collections';
import type { GeneratedTsconfigGraphResult } from '../../core/build-graph/types';
import { frameworkCheckerName } from '../framework-targets';
import { getCheckerImplementationFingerprint } from '../managed/identity';
import type { TypecheckTarget } from '../targets';
import type { ExecutionReferenceClosure } from './reference-closure';

export function captureExecutionBinding(options: {
  target: TypecheckTarget;
  graph: GeneratedTsconfigGraphResult;
  projectRootDir: string;
  closure: ExecutionReferenceClosure;
  authority?: object;
}): string {
  const { target, graph, projectRootDir, closure, authority } = options;
  return JSON.stringify([
    captureTarget(target, graph, projectRootDir),
    graph.artifactPlan.desiredRevision,
    closure.references,
    [...closure.inputs].sort(compareCodeUnits),
    [...(closure.observations?.paths ?? [])].sort(compareCodeUnits),
    authority,
  ]);
}

export function captureTarget(
  target: TypecheckTarget,
  graph: GeneratedTsconfigGraphResult,
  projectRootDirectory: string,
): string | Error {
  try {
    const checker = selectedChecker(target, graph);
    if (checker === undefined)
      throw new Error('Selected Checker identity is unavailable.');
    return JSON.stringify([
      target,
      getCheckerImplementationFingerprint({
        checker,
        target,
        projectRootDir: projectRootDirectory,
      }),
    ]);
  } catch (error) {
    return asError(error);
  }
}
export function assertTargetIdentity(
  expected: string | Error | undefined,
  current: string | Error,
): void {
  assertIdentityAvailable(expected);
  assertIdentityAvailable(current);
  if (expected !== current)
    throw new Error(
      'Execution target selection or Checker implementation changed.',
    );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
function assertIdentityAvailable(identity: string | Error | undefined): void {
  if (identity instanceof Error) throw identity;
}

function selectedChecker(
  target: TypecheckTarget,
  graph: GeneratedTsconfigGraphResult,
) {
  return target.checkerFamily === undefined
    ? graph.checkers.find((item) => item.name === target.checkerName)
    : { name: frameworkCheckerName(target.checkerFamily) };
}
