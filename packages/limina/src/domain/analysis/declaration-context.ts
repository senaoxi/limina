import type {
  CheckerAuthority,
  DeclarationRequestReceipt,
} from './declaration-governance';
import type { NativeCoverage, NativeFileIdentity } from './native-coverage';

/**
Governance decisions never change the compiler's obligation assessment.
*/
export interface DeclarationContextDecision {
  readonly kind: 'consumption' | 'root-input';
  readonly consumerConfig: string;
  readonly contextId: string;
  readonly file: NativeFileIdentity;
  readonly requestIds: readonly string[];
  readonly coverage: NativeCoverage;
  readonly selection:
    | { readonly state: 'local'; readonly config: string }
    | {
        readonly state: 'selected';
        readonly config: string;
        readonly basis: 'unique-coverage' | 'explicit-selection';
      }
    | {
        readonly state: 'awaiting-selection' | 'unavailable';
        readonly reason: string;
      };
}

export interface DeclarationContextReceipt {
  readonly version: 3;
  readonly authority: CheckerAuthority;
  readonly contextId: string;
  readonly generatedConfig: string;
  readonly sourceConfig: string;
  readonly checker: string;
  readonly compilerVersion: string;
  readonly inputFingerprint: string;
  readonly decisionsFingerprint: string;
  readonly mappings: readonly {
    readonly file: string;
    readonly sourceConfig: string;
    readonly referenceConfig: string;
    readonly loaded: boolean;
  }[];
  readonly referenceMappings: readonly {
    readonly file: string;
    readonly referenceConfig: string | null;
    readonly declarationOutput: string | null;
    readonly qualified: boolean;
  }[];
  readonly requests: readonly DeclarationRequestReceipt[];
}
