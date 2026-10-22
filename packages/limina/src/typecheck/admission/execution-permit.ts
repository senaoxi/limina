import type { GeneratedTsconfigGraphResult } from '../../core/build-graph/types';
import type { LiminaPreflightManager } from '../../preflight';
import type { ExecutionPermit, ExecutionStage } from './types';

export class InvalidExecutionPermit extends Error {}
export type PermitAuthority =
  | ExecutionStage
  | { stage: ExecutionStage; authority: object };
export interface PermitBinding {
  owner: object;
  target: string;
  stage: ExecutionStage;
  graph: GeneratedTsconfigGraphResult;
  providers: LiminaPreflightManager['providers'];
  namespace: LiminaPreflightManager['artifactNamespace'];
  snapshot: string;
  binding: string;
  authority?: object;
}
const permits = new WeakMap<ExecutionPermit, PermitBinding>();
/**
Callback lifetime and object identity are part of the capability; fields cannot recreate it.
*/
export async function withExecutionPermit<T>(
  binding: PermitBinding,
  action: (permit: ExecutionPermit) => Promise<T>,
): Promise<T> {
  const permit = Object.freeze({}) as ExecutionPermit;
  permits.set(permit, binding);
  try {
    return await action(permit);
  } finally {
    permits.delete(permit);
  }
}
export function assertExecutionPermit(
  permit: ExecutionPermit,
  expected: PermitBinding,
): void {
  const binding = permits.get(permit);
  if (binding === undefined || !hasMatchingBinding(binding, expected))
    throw new InvalidExecutionPermit('Execution permit is invalid or expired.');
}
function hasMatchingBinding(
  actual: PermitBinding,
  expected: PermitBinding,
): boolean {
  return [
    actual.owner === expected.owner,
    actual.target === expected.target,
    actual.stage === expected.stage,
    actual.authority === expected.authority,
    actual.graph === expected.graph,
    actual.providers === expected.providers,
    actual.namespace === expected.namespace,
    actual.snapshot === expected.snapshot,
    actual.binding === expected.binding,
  ].every(Boolean);
}
