import type { DeclarationContextDecision } from '../../domain/analysis/declaration-context';
import type { DeclarationCompilationEvidence } from '../../domain/analysis/declaration-governance';
import type { NativeFileIdentity } from '../../domain/analysis/native-coverage';

export interface DeclarationRequestScope {
  readonly inactiveRequests: ReadonlySet<string>;
  isActiveSource(file: string): boolean;
}

/** Reachability through the actual input occurrences. A helper reachable from
 * an independent input stays active even when another route is delegated. */
export function declarationRequestScope(
  consumer: string,
  evidence: DeclarationCompilationEvidence | undefined,
  decisions: readonly DeclarationContextDecision[],
  roots: readonly NativeFileIdentity[],
  key: (file: string) => string,
): DeclarationRequestScope {
  const blocked = new Set(
    decisions
      .filter(
        (decision) =>
          !('config' in decision.selection) ||
          decision.selection.config !== consumer,
      )
      .map((decision) => key(decision.file.lexicalPath)),
  );
  const inactiveRequests = new Set<string>();
  if (evidence !== undefined && blocked.size > 0) {
    const origins = new Map(
      evidence.requestOrigins.map((item) => [item.id, key(item.file)]),
    );
    const outgoing = new Map<string, Set<string>>();
    const inputs = new Set<string>();
    const pending = roots.map((file) => key(file.lexicalPath));
    for (const relation of evidence.declarations) {
      const target = key(relation.file.lexicalPath);
      inputs.add(target);
      if (relation.kind === 'root-input') pending.push(target);
      else
        for (const request of relation.requestIds) {
          const source = origins.get(request);
          if (source === undefined) continue;
          const next = outgoing.get(source) ?? new Set<string>();
          next.add(target);
          outgoing.set(source, next);
        }
    }
    for (const source of outgoing.keys())
      if (!inputs.has(source)) pending.push(source);
    const active = new Set<string>();
    while (pending.length > 0) {
      const source = pending.pop()!;
      if (blocked.has(source) || active.has(source)) continue;
      active.add(source);
      const next = outgoing.get(source);
      if (next) for (const target of next) pending.push(target);
    }
    for (const input of inputs) if (!active.has(input)) blocked.add(input);
    for (const [id, source] of origins)
      if (blocked.has(source)) inactiveRequests.add(id);
  }
  return {
    inactiveRequests,
    isActiveSource: (file: string) =>
      blocked.size === 0 || !blocked.has(key(file)),
  };
}
