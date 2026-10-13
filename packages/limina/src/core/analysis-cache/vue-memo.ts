import type { VueProjectSemanticIdentity } from '#checkers';
import { AnalysisInputDriftError } from './contracts';
import type {
  VueQueryKind,
  VueQueryRecord,
  VueQueryResults,
} from './vue-contracts';
import { vueContextId } from './vue-identity';
import { decodeVueQuery } from './vue-schema';

interface QualifiedIdentity {
  contextId: string;
  generation: number;
  id: string;
}

function freezeData(data: readonly unknown[]): void {
  for (const item of data) {
    if (Array.isArray(item)) freezeData(item);
  }
  Object.freeze(data);
}

export class VueAnalysisMemo {
  readonly #identities = new Map<
    VueProjectSemanticIdentity,
    QualifiedIdentity
  >();
  readonly #queries = new WeakMap<
    VueQueryRecord,
    VueQueryResults[VueQueryKind]
  >();

  #decode<K extends VueQueryKind>(
    kind: K,
    record: VueQueryRecord,
  ): VueQueryResults[K] | undefined {
    const result = decodeVueQuery(kind, record.data);
    if (result !== undefined) {
      freezeData(record.data);
      Object.freeze(record);
      this.#queries.set(record, result);
    }
    return result;
  }

  #result<K extends VueQueryKind>(
    kind: K,
    record: VueQueryRecord,
  ): VueQueryResults[K] | undefined {
    const result = this.#queries.get(record) ?? this.#decode(kind, record);
    // Callers previously received a fresh decode. Keep that isolation even
    // when the validated result is shared inside this cache instance.
    return structuredClone(result) as VueQueryResults[K] | undefined;
  }

  contextId(identity: VueProjectSemanticIdentity): string {
    let qualified = this.#identities.get(identity);
    if (qualified === undefined) {
      qualified = {
        contextId: vueContextId(identity),
        generation: identity.generation,
        id: identity.id,
      };
      this.#identities.set(identity, qualified);
    }
    return qualified.contextId;
  }

  // Identities belong to one semantic generation. Check their complete data
  // again at capture, so memoization cannot publish after in-memory drift.
  assertStable(): void {
    for (const [identity, qualified] of this.#identities)
      assertIdentityStable(identity, qualified);
  }

  decode<K extends VueQueryKind>(
    kind: K,
    record: VueQueryRecord | undefined,
  ): VueQueryResults[K] | undefined {
    return record?.kind === kind ? this.#result(kind, record) : undefined;
  }
}

function assertIdentityStable(
  identity: VueProjectSemanticIdentity,
  qualified: QualifiedIdentity,
): void {
  const stable = [
    identity.generation === qualified.generation,
    identity.id === qualified.id,
    identity.virtualFiles.size === 0,
    vueContextId(identity) === qualified.contextId,
  ];
  if (!stable.every(Boolean))
    throw new AnalysisInputDriftError(identity.configPath);
}
