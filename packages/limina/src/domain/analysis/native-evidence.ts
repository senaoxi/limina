import { declarationResponsibility } from './declaration-governance';
/**
 * Native DTO contract. A snapshot records evidence; it never authorizes
 * execution. Version 5 shares declaration responsibility with checker-qualified governance.
 */
import type {
  NativeEvidenceContext,
  NativeEvidenceOrigin,
} from './native-context';
import type {
  NativeCoverage,
  NativeFileIdentity,
  SourceConfigCoverageIndex,
} from './native-coverage';
import type { NativeCompilationObligation } from './native-obligation';

export const NATIVE_EVIDENCE_VERSION = 5;

export interface NativeRequest {
  readonly id: string;
  readonly consumerContextId: string;
  readonly origin: NativeEvidenceOrigin;
  readonly channel:
    | 'module'
    | 'type-directive'
    | 'path-directive'
    | 'library'
    | 'ambient'
    | 'implicit';
  readonly sourceFile: NativeFileIdentity | null;
  readonly entry:
    | {
        readonly kind: 'source';
        readonly file: NativeFileIdentity;
        readonly position: number;
      }
    | {
        readonly kind: 'config';
        readonly configId: string;
        readonly field: string;
      }
    | { readonly kind: 'compiler'; readonly reason: string };
  readonly specifier: string;
  readonly resolutionMode: string | null;
  readonly predecessorId: string | null;
}

export interface NativePathSelection {
  readonly state: 'selected' | 'missing' | 'disabled' | 'unavailable';
  readonly lexicalPath: string;
  readonly logicalTarget: string | null;
  readonly candidates: readonly {
    readonly lexicalPath: string;
    readonly physicalPath: string;
    readonly present: boolean;
  }[];
  readonly rule: string;
  readonly reason?: string;
}

export interface NativeResolution {
  readonly pathSelection?: NativePathSelection;
  readonly requestId: string;
  readonly state: 'resolved' | 'unresolved' | 'ambient' | 'unavailable';
  readonly target: NativeFileIdentity | null;
  readonly rawRedirectEvidenceIds: readonly string[];
  readonly externalLibrary: boolean | null;
  readonly compilerLoad: 'loaded' | 'attempted' | 'not-observed' | 'unknown';
  readonly evidenceIds: readonly string[];
}

export type NativeStopReason =
  | 'uncovered'
  | 'coverage-unavailable'
  | 'ambiguous-implementation'
  | 'foreign-implementation'
  | 'declaration-context-boundary'
  | 'same-owner-non-root'
  | 'unresolved'
  | 'observation-unavailable'
  | 'resolution-disabled'
  | 'input-drift'
  | 'unsupported-observation';

export type NativeFrontierDecision =
  | {
      readonly action: 'expand';
      readonly basis: 'root' | 'covered-declaration' | 'consumer-declaration';
    }
  | { readonly action: 'stop'; readonly reason: NativeStopReason };

export interface NativeFrontierInput {
  readonly root: boolean;
  readonly kind: 'declaration' | 'implementation';
  readonly consumerConfigId: string;
  readonly coverage: NativeCoverage;
}

function implementationStop(input: NativeFrontierInput): NativeStopReason {
  if (input.coverage.state === 'ambiguous') return 'ambiguous-implementation';
  const isConsumer = input.coverage.members.some(
    (member) => member.configId === input.consumerConfigId,
  );
  return isConsumer ? 'same-owner-non-root' : 'foreign-implementation';
}

function uncoveredStop(coverage: NativeCoverage): NativeStopReason {
  return coverage.state === 'uncovered' ? 'uncovered' : 'coverage-unavailable';
}

/**
Pure policy contract, not a CompilerHost or a production frontier.
*/
export function decideNativeFrontier(
  input: NativeFrontierInput,
): NativeFrontierDecision {
  if (isImplementationRoot(input)) return { action: 'expand', basis: 'root' };
  return input.kind === 'declaration'
    ? declarationFrontier(input)
    : implementationFrontier(input);
}

function declarationFrontier(
  input: NativeFrontierInput,
): NativeFrontierDecision {
  const responsibility = declarationResponsibility({
    sourceConfig: input.consumerConfigId,
    root: input.root,
    coverage: input.coverage,
  });
  switch (responsibility.kind) {
    case 'local': {
      return { action: 'expand', basis: 'covered-declaration' };
    }
    case 'consumer': {
      return { action: 'expand', basis: 'consumer-declaration' };
    }
    case 'delegate': {
      return { action: 'stop', reason: 'declaration-context-boundary' };
    }
    default: {
      return { action: 'stop', reason: uncoveredStop(input.coverage) };
    }
  }
}

function implementationFrontier(
  input: NativeFrontierInput,
): NativeFrontierDecision {
  return {
    action: 'stop',
    reason:
      input.coverage.state === 'unique' || input.coverage.state === 'ambiguous'
        ? implementationStop(input)
        : uncoveredStop(input.coverage),
  };
}

export type NativeProjectRelation =
  | {
      readonly kind: 'resolved-project-use';
      readonly consumerContextId: string;
      readonly targetConfigId: string;
      readonly coverageEvidenceId: string;
      readonly requestIds: readonly string[];
    }
  | {
      readonly kind: 'compiler-reference-obligation';
      readonly obligationId: string;
    }
  | {
      readonly kind: 'declaration-consumption';
      readonly consumerContextId: string;
      readonly file: NativeFileIdentity;
      readonly requestIds: readonly string[];
    }
  | {
      readonly kind:
        | 'explicit-reference'
        | 'framework-schedule'
        | 'runtime-use';
      readonly consumerContextId: string;
      readonly targetConfigId: string | null;
      readonly evidenceIds: readonly string[];
    };

interface NativePartitionScope {
  readonly contextId: string;
  readonly entryId: string;
  readonly channel: NativeRequest['channel'];
  readonly evidenceIds: readonly string[];
}

export type NativeCompletenessPartition = NativePartitionScope &
  (
    | { readonly state: 'observed' | 'restored' }
    | {
        readonly state: 'proven-stop';
        readonly stopReason: Exclude<
          NativeStopReason,
          'input-drift' | 'unsupported-observation'
        >;
      }
    | {
        readonly state: 'gap';
        readonly failureId: string;
        readonly cause:
          | 'unavailable'
          | 'input-drift'
          | 'unsupported'
          | 'internal-failure';
      }
  );

export interface NativeEvidenceFailure {
  readonly id: string;
  readonly detail: string;
  readonly kind:
    | 'config-parse'
    | 'file-read'
    | 'compiler-initialization'
    | 'identity'
    | 'unsupported'
    | 'input-drift'
    | 'internal';
  readonly evidenceIds: readonly string[];
  readonly affected:
    | { readonly kind: 'universe'; readonly universeId: string }
    | { readonly kind: 'contexts'; readonly contextIds: readonly string[] }
    | {
        readonly kind: 'entries';
        readonly contextId: string;
        readonly entryIds: readonly string[];
      };
}

export interface NativeTraversalLink {
  readonly requestId: string;
  /**
  Multiple incoming requests and cycles remain explicit, without a fake tree.
  */
  readonly parentRequestIds: readonly string[];
  readonly rootFileNames: readonly string[];
}

export interface NativeEvidenceSnapshot {
  readonly version: typeof NATIVE_EVIDENCE_VERSION;
  readonly run: 'completed' | 'unavailable' | 'interrupted' | 'failed';
  readonly contexts: readonly NativeEvidenceContext[];
  readonly coverageIndexes: readonly SourceConfigCoverageIndex[];
  readonly coverage: readonly NativeCoverage[];
  readonly requests: readonly NativeRequest[];
  readonly traversal: readonly NativeTraversalLink[];
  readonly resolutions: readonly NativeResolution[];
  readonly relations: readonly NativeProjectRelation[];
  readonly obligations: readonly NativeCompilationObligation[];
  readonly completeness: readonly NativeCompletenessPartition[];
  readonly failures: readonly NativeEvidenceFailure[];
}

function isImplementationRoot(input: NativeFrontierInput): boolean {
  return input.root && input.kind === 'implementation';
}
