import type { VueProjectSemanticIdentity } from '#checkers';
import { AnalysisInputDriftError } from './contracts';
import { isDecodedRecord } from './record-table';
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
      if (!isDecodedRecord(record.data)) freezeData(record.data);
      Object.freeze(record);
      this.#queries.set(record, result);
    }
    return result;
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
    return structuredClone(this.read(kind, record));
  }

  /**
  Returns a recursively frozen query result owned by the decoder.
  */
  read<K extends VueQueryKind>(
    kind: K,
    record: VueQueryRecord | undefined,
  ): VueQueryResults[K] | undefined {
    return record?.kind === kind
      ? ((this.#queries.get(record) ?? this.#decode(kind, record)) as
          | VueQueryResults[K]
          | undefined)
      : undefined;
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
