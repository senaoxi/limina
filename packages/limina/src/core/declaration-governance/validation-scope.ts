import type { DeclarationContextDecision } from '../../domain/analysis/declaration-context';
import type { DeclarationCompilationEvidence } from '../../domain/analysis/declaration-governance';

interface ScopeInput {
  decisions: readonly DeclarationContextDecision[];
  evidence: readonly DeclarationCompilationEvidence[];
  fileKey(file: string): string;
}
interface Transition {
  file: string;
  decision: DeclarationContextDecision | undefined;
}
const key = (config: string, file: string) => JSON.stringify([config, file]);

/** Follow already inventoried declaration requests, not every project's private
 * consumption in the reference closure. Implementation dependencies delegate
 * compilation to their project; they do not inherit all its declaration input
 * contexts into their consumer. Build the occurrence index once per validation. */
export function createDeclarationValidationScope(
  input: ScopeInput,
): (config: string) => DeclarationContextDecision[] {
  const keys = new Map<string, string>();
  const fileKey = (file: string) => {
    const value = keys.get(file) ?? input.fileKey(file);
    keys.set(file, value);
    return value;
  };
  const transitions = declarationTransitions(input, fileKey);
  return (config) => {
    const seeds = input.decisions.filter(
      (decision) =>
        decision.consumerConfig === config ||
        (decision.selection.state === 'selected' &&
          decision.selection.config === config),
    );
    const retained = new Set(seeds);
    const pending = seeds.flatMap((decision) => selectedContext(decision));
    const visited = new Set<string>();
    while (pending.length > 0) {
      const [owner, file] = pending.pop()!;
      const identity = key(owner, fileKey(file));
      if (visited.has(identity)) continue;
      visited.add(identity);
      const nextRequests = transitions.get(identity) ?? [];
      for (const next of nextRequests) {
        if (next.decision === undefined) pending.push([owner, next.file]);
        else {
          retained.add(next.decision);
          pending.push(...selectedContext(next.decision));
        }
      }
    }
    return input.decisions.filter((decision) => retained.has(decision));
  };
}

function selectedContext(
  decision: DeclarationContextDecision,
): [string, string][] {
  return decision.selection.state === 'local' ||
    decision.selection.state === 'selected'
    ? [[decision.selection.config, decision.file.lexicalPath]]
    : [];
}

function declarationTransitions(
  input: ScopeInput,
  fileKey: ScopeInput['fileKey'],
): Map<string, Transition[]> {
  const byRequest = new Map(
    input.decisions.flatMap((decision) =>
      decision.requestIds.map(
        (id) => [key(decision.contextId, id), decision] as const,
      ),
    ),
  );
  const transitions = new Map<string, Transition[]>();
  for (const evidence of input.evidence) {
    const origins = new Map(
      evidence.requestOrigins.map((origin) => [origin.id, origin.file]),
    );
    for (const observation of evidence.declarations) {
      if (
        observation.kind !== 'consumption' ||
        observation.contextId !== evidence.contextId
      )
        continue;
      for (const request of observation.requestIds) {
        const source = origins.get(request);
        if (source === undefined || !/\.d\.[cm]?ts$/i.test(source)) continue;
        const identity = key(evidence.sourceConfig, fileKey(source));
        const entries = transitions.get(identity) ?? [];
        entries.push({
          file: observation.file.lexicalPath,
          decision: byRequest.get(key(observation.contextId, request)),
        });
        transitions.set(identity, entries);
      }
    }
  }
  return transitions;
}
