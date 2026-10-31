import { normalizeAbsolutePath } from '#utils/path';
import type { NativeEvidenceSnapshot } from '../../domain/analysis/native-evidence';
import { summarizeCompilationObligation } from '../../domain/analysis/native-obligation';
import { DeclarationObservationUnavailable } from '../declaration-governance/candidate';

/** Already observed consumer inputs only. External, suppressed and delegated
 * requests cannot establish a new local membership requirement here. */
export function jsonMembershipInputs(
  snapshot: NativeEvidenceSnapshot,
  contextId: string,
): Map<string, string> {
  const requests = new Set(
    snapshot.requests
      .filter(
        (request) =>
          request.consumerContextId === contextId &&
          request.sourceFile !== null &&
          ['module', 'path-directive'].includes(request.channel),
      )
      .map((request) => request.id),
  );
  const inputs = new Map<string, string>();
  for (const resolution of snapshot.resolutions) {
    if (
      requests.has(resolution.requestId) &&
      resolution.state === 'resolved' &&
      resolution.target?.lexicalPath.endsWith('.json') &&
      resolution.externalLibrary !== true &&
      snapshot.obligations.some(
        (obligation) =>
          obligation.requestIds.includes(resolution.requestId) &&
          obligation.targetConfigId === null &&
          summarizeCompilationObligation(obligation) === 'unknown',
      )
    )
      inputs.set(resolution.requestId, resolution.target.lexicalPath);
  }
  return inputs;
}

export function validateJsonInputMembership(
  targets: Iterable<string>,
  roots: readonly string[],
  consumer: string,
): void {
  const members = new Set(roots.map(normalizeAbsolutePath));
  for (const target of targets)
    if (!members.has(target))
      throw new DeclarationObservationUnavailable(
        `Generated JSON input is outside source membership: ${target}; consumer: ${consumer}. Include the JSON input in the source config files/include before generating an emitting project.`,
      );
}
