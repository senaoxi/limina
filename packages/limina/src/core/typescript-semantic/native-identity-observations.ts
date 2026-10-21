import { normalizeAbsolutePath } from '#utils/path';
import type { NativeFileIdentity } from '../../domain/analysis/native-coverage';
import {
  nativeFingerprint,
  observeNativeFileIdentity,
} from './native-file-identity';
import { NativeObservationError } from './native-observation-failure';

/**
 * One synchronous observation transaction owns this memo. Publication rechecks
 * every observed path, including targets the compiler never attempted to load.
 */
export class NativeIdentityObservations {
  readonly #files = new Map<string, NativeFileIdentity>();
  readonly inputVersion: string;
  constructor(inputVersion: string) {
    this.inputVersion = inputVersion;
  }

  read(fileName: string): NativeFileIdentity {
    const path = normalizeAbsolutePath(fileName);
    const prior = this.#files.get(path);
    if (prior !== undefined) return prior;
    const file = observeNativeFileIdentity(path, this.inputVersion);
    this.#files.set(path, file);
    return file;
  }

  assertStable(): void {
    for (const [path, prior] of this.#files) {
      const current = observeNativeFileIdentity(path, this.inputVersion);
      if (nativeFingerprint(current) !== nativeFingerprint(prior))
        throw new NativeObservationError(
          'input-drift',
          `Native source identity drift: ${path}`,
        );
    }
  }
}
