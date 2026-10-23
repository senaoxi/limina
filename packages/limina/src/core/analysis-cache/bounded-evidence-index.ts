import {
  deriveNativeCoverage,
  type NativeCoverage,
  type NativeFileIdentity,
} from '../../domain/analysis/native-coverage';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import type { NativeContextRecord } from './contracts';

type Snapshot = NonNullable<NativeContextRecord['native']>['snapshot'];

/**
Local joins only; qualification still checks duplicates and full coverage.
*/
export class BoundedEvidenceIndex {
  readonly #coverageIndex: Snapshot['coverageIndexes'][number];
  readonly #coverage = new Map<string, NativeCoverage>();
  readonly requests: Map<string, Snapshot['requests'][number]>;
  readonly resolutions: Map<string, Snapshot['resolutions'][number]>;
  readonly obligations: Map<string, Snapshot['obligations'][number]>;

  constructor(snapshot: Snapshot) {
    this.#coverageIndex = snapshot.coverageIndexes[0]!;
    this.requests = new Map(
      snapshot.requests.map((entry) => [entry.id, entry]),
    );
    this.resolutions = new Map(
      snapshot.resolutions.map((entry) => [entry.requestId, entry]),
    );
    this.obligations = new Map(
      snapshot.obligations.flatMap((entry) =>
        entry.requestIds.map((id) => [id, entry] as const),
      ),
    );
  }

  coverage(target: NativeFileIdentity): NativeCoverage {
    // One synchronous qualification owns this index. Never retain qualification
    // results across calls: a restored DTO can still be changed by its caller.
    const key = nativeFingerprint(target);
    const previous = this.#coverage.get(key);
    if (previous !== undefined) return previous;
    const coverage = deriveNativeCoverage(this.#coverageIndex, target);
    this.#coverage.set(key, coverage);
    return coverage;
  }
}
