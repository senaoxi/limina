import { readAnalysisInput } from '#utils/analysis-input';
import { normalizeAbsolutePath } from '#utils/path';
import {
  type PhysicalFileIdentity,
  readPhysicalFileIdentity,
} from '#utils/physical-file-identity';
import type { NativeFileIdentity } from '../../domain/analysis/native-coverage';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
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
  readonly #declarations = new Map<string, PhysicalFileIdentity>();
  readonly inputVersion: string;
  constructor(inputVersion: string) {
    this.inputVersion = inputVersion;
  }

  read(fileName: string): NativeFileIdentity {
    const path = normalizeAbsolutePath(fileName);
    const prior = this.#files.get(path);
    if (prior !== undefined) return prior;
    const file = observeNativeFileIdentity(path, this.inputVersion);
    // A stopped declaration is still an execution input. Its metadata receipt
    // must survive without making content changes alter workspace membership.
    if (isDeclarationFile(path))
      this.#declarations.set(path, observeDeclaration(path));
    this.#files.set(path, file);
    return file;
  }

  assertStable(): void {
    for (const [path, prior] of this.#declarations)
      if (
        nativeFingerprint(observeDeclaration(path)) !== nativeFingerprint(prior)
      )
        throw new NativeObservationError(
          'input-drift',
          `Native declaration input drift: ${path}`,
        );
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

function observeDeclaration(path: string): PhysicalFileIdentity {
  return readAnalysisInput(
    path,
    () => readPhysicalFileIdentity(path),
    'file-identity',
  );
}
