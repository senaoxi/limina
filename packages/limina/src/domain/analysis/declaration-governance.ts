import type {
  NativeCoverage,
  NativeFileIdentity,
  SourceConfigCoverageIndex,
} from './native-coverage';

/** Serializable authority. A compiler implementation is not interchangeable
 * with another checker using the same TypeScript version. */
export interface CheckerAuthority {
  readonly checker: string;
  readonly adapter: string;
  readonly toolchain: string;
  readonly executionEntry: string;
}

export type CompilationPurpose =
  | 'graph'
  | 'candidate-validation'
  | 'type-provider';

export interface DeclarationLoadingPlan {
  readonly version: 1;
  readonly sourceConfig: string;
  readonly purpose: CompilationPurpose;
  readonly coverage: SourceConfigCoverageIndex;
}

export interface DeclarationObservation {
  readonly kind: 'consumption' | 'root-input';
  readonly contextId: string;
  readonly consumerConfig: string;
  readonly file: NativeFileIdentity;
  readonly requestIds: readonly string[];
}

export interface DeclarationCompilationEvidence {
  readonly version: 5;
  readonly authority: CheckerAuthority;
  readonly sourceConfig: string;
  readonly contextId: string;
  readonly purpose: CompilationPurpose;
  readonly coverageVersion: string;
  readonly requestOrigins: readonly {
    readonly id: string;
    readonly file: string;
    readonly specifier: string;
  }[];
  readonly declarations: readonly DeclarationObservation[];
  readonly completeness: 'complete' | 'incomplete';
}

export type DeclarationResponsibility =
  | { readonly kind: 'local' | 'consumer' }
  | { readonly kind: 'delegate'; readonly candidates: readonly string[] }
  | { readonly kind: 'unknown'; readonly reason: string };

/** Coverage selects responsibility, never a resolution, an obligation or an
 * exclusive file owner. Loading requires a separate checker request grant. */
export function declarationResponsibility(input: {
  readonly sourceConfig: string;
  readonly root: boolean;
  readonly coverage: NativeCoverage;
}): DeclarationResponsibility {
  const { coverage } = input;
  if (
    input.root &&
    coverage.members.some((member) => member.configId === input.sourceConfig)
  )
    return { kind: 'local' };
  if (input.root)
    return {
      kind: 'unknown',
      reason: 'Declaration root is not covered by its source configuration.',
    };
  if (coverage.completeness !== 'complete')
    return { kind: 'unknown', reason: coverage.gaps.join(', ') };
  return coverage.members.length === 0
    ? { kind: 'consumer' }
    : {
        kind: 'delegate',
        candidates: coverage.members.map((member) => member.configId),
      };
}

export interface CheckerRequestInventory {
  readonly requests: readonly DeclarationRequestReceipt[];
  readonly complete: boolean;
}

export interface DeclarationRequestReceipt {
  readonly file: string;
  readonly position: number;
  readonly channel: string;
  readonly specifier: string;
  readonly mode: string | null;
  readonly target: string | null;
  readonly resolutionState:
    | 'resolved'
    | 'unresolved'
    | 'ambient'
    | 'suppressed'
    | 'unavailable';
  readonly redirects: readonly string[];
  readonly environment: Readonly<Record<string, unknown>>;
  readonly externalLibrary: boolean | null;
}
