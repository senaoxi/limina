import { normalizeAbsolutePath } from '#utils/path';
import type {
  NativeCoverage,
  NativeFileIdentity,
  SourceConfigCoverageIndex,
} from '../../domain/analysis/native-coverage';
import {
  decideNativeFrontier,
  type NativeFrontierDecision,
} from '../../domain/analysis/native-evidence';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import { deriveCompilerCoverage } from './compiler-coverage';
import type { TypeScriptSemanticProject } from './contracts';
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
  readonly #declarationRoots = new Set<string>();
  readonly #observations = new Map<string, NativeSourceAttempt>();
  readonly #attempts = new Map<string, NativeSourceAttempt>();
  readonly identities: NativeIdentityObservations;
  readonly configId: string;
  readonly index: SourceConfigCoverageIndex;
  readonly validation?: TypeScriptSemanticProject['declarationContextValidation'];

  constructor(
    configId: string,
    roots: readonly string[],
    index: SourceConfigCoverageIndex,
    validation?: TypeScriptSemanticProject['declarationContextValidation'],
  ) {
    this.identities = new NativeIdentityObservations(index.inputVersion);
    this.configId = configId;
    this.index = index;
    this.validation = validation;
    this.#roots = new Set(roots.map(normalizeAbsolutePath));
    for (const root of roots) {
      if (!isDeclarationFile(root)) continue;
      const file = this.identities.read(root);
      if (file.physical.state === 'verified')
        this.#declarationRoots.add(file.physical.canonicalId);
    }
  }

  inspect(fileName: string): NativeSourceAttempt {
    const path = normalizeAbsolutePath(fileName);
    const prior = this.#observations.get(path);
    if (prior !== undefined) return prior;
    const file = this.identities.read(path);
    const coverage = deriveCompilerCoverage(this.index, file);
    const observation = {
      file,
      coverage,
      decision: decideNativeFrontier({
        consumerConfigId: this.validation?.sourceConfig ?? this.configId,
        root:
          this.#roots.has(file.lexicalPath) ||
          (isDeclarationFile(file.lexicalPath) &&
            file.physical.state === 'verified' &&
            this.#declarationRoots.has(file.physical.canonicalId)),
        kind: isDeclarationFile(file.lexicalPath)
          ? 'declaration'
          : 'implementation',
        coverage,
      }),
    };
    if (
      this.validation?.allowedDeclarations.includes(path) &&
      isDeclarationFile(path) &&
      coverage.members.length > 0
    )
      observation.decision = { action: 'expand', basis: 'covered-declaration' };
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
