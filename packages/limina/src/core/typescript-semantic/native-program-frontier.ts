import { normalizeAbsolutePath } from '#utils/path';
import {
  deriveNativeCoverage,
  type NativeCoverage,
  type NativeFileIdentity,
  type SourceConfigCoverageIndex,
} from '../../domain/analysis/native-coverage';
import {
  decideNativeFrontier,
  type NativeFrontierDecision,
} from '../../domain/analysis/native-evidence';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import { NativeIdentityObservations } from './native-identity-observations';

export interface NativeSourceAttempt {
  readonly file: NativeFileIdentity;
  readonly coverage: NativeCoverage;
  readonly decision: NativeFrontierDecision;
}

/**
 * The host consults this before SourceFile creation. No libraries, declarations,
 * reference outputs or support importers bypass Source Config Coverage.
 */
export class NativeProgramFrontier {
  readonly #roots: Set<string>;
  readonly #observations = new Map<string, NativeSourceAttempt>();
  readonly #attempts = new Map<string, NativeSourceAttempt>();
  readonly identities: NativeIdentityObservations;
  readonly configId: string;
  readonly index: SourceConfigCoverageIndex;

  constructor(
    configId: string,
    roots: readonly string[],
    index: SourceConfigCoverageIndex,
  ) {
    this.identities = new NativeIdentityObservations(index.inputVersion);
    this.configId = configId;
    this.index = index;
    this.#roots = new Set(roots.map(normalizeAbsolutePath));
  }

  inspect(fileName: string): NativeSourceAttempt {
    const path = normalizeAbsolutePath(fileName);
    const prior = this.#observations.get(path);
    if (prior !== undefined) return prior;
    const file = this.identities.read(path);
    const coverage = deriveNativeCoverage(this.index, file);
    const observation = {
      file,
      coverage,
      decision: decideNativeFrontier({
        consumerConfigId: this.configId,
        root: this.#roots.has(file.lexicalPath),
        kind: isDeclarationFile(file.lexicalPath)
          ? 'declaration'
          : 'implementation',
        coverage,
      }),
    };
    this.#observations.set(path, observation);
    return observation;
  }

  allow(fileName: string): boolean {
    const attempt = this.inspect(fileName);
    this.#attempts.set(attempt.file.lexicalPath, attempt);
    return attempt.decision.action === 'expand';
  }

  get attempts(): readonly NativeSourceAttempt[] {
    return this.#attempts.values().toArray();
  }
}
