import type { NativeContextRecord } from './contracts';

type Snapshot = NonNullable<NativeContextRecord['native']>['snapshot'];

/**
Local joins only; qualification still checks duplicates and full coverage.
*/
export class BoundedEvidenceIndex {
  readonly requests: Map<string, Snapshot['requests'][number]>;
  readonly resolutions: Map<string, Snapshot['resolutions'][number]>;
  readonly obligations: Map<string, Snapshot['obligations'][number]>;

  constructor(snapshot: Snapshot) {
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
}
