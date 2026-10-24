import type { NativeCoverage, NativeFileIdentity } from './native-coverage';

/**
Governance decisions never change the compiler's obligation assessment.
*/
export interface DeclarationContextDecision {
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
  readonly version: 1;
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
  }[];
  readonly requests: readonly {
    readonly file: string;
    readonly position: number;
    readonly channel: string;
    readonly specifier: string;
    readonly mode: string | null;
    readonly target: string | null;
    readonly redirects: readonly string[];
  }[];
}
