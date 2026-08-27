import type {
  FrameworkCapabilityDescriptor,
  GovernedSourceUnit,
} from '#core/build-graph/runner';

export type FrameworkFamily = FrameworkCapabilityDescriptor['family'];

export interface GovernedSourceEntry {
  checkerName: string;
  unit: GovernedSourceUnit;
}

export type FrameworkGovernanceProofFacts =
  | {
      readonly checkerName: string;
      readonly configPath: string;
      readonly kind: 'governed-source';
      readonly violation: 'missing-runtime-unit' | 'unlisted-runtime-unit';
    }
  | {
      readonly configPath: string;
      readonly kind: 'primary-owner';
      readonly owners: readonly {
        readonly checkerName: string;
        readonly preset: string;
      }[];
    }
  | {
      readonly checkerNames: readonly string[];
      readonly configPath: string;
      readonly family: FrameworkFamily;
      readonly kind: 'framework-capability';
      readonly violation:
        | 'descriptor-mismatch'
        | 'duplicate'
        | 'missing'
        | 'unexpected';
    }
  | {
      readonly configPath: string;
      readonly family: FrameworkFamily;
      readonly kind: 'framework-target';
      readonly problems: readonly string[];
      readonly targetIds: readonly string[];
      readonly violation:
        | 'duplicate-id'
        | 'invalid-shape'
        | 'missing'
        | 'preflight-failed';
    }
  | {
      readonly configPath: string;
      readonly kind: 'build-projection';
      readonly projection:
        | 'declaration-project'
        | 'framework-checker'
        | 'transparent-solution'
        | 'wrapped-project';
      readonly violation:
        | 'declaration-provider-mismatch'
        | 'framework-source-in-declaration'
        | 'solution-kind-mismatch';
    }
  | {
      readonly configPath: string;
      readonly generatedConfigPath: string;
      readonly kind: 'generated-build-extension';
      readonly unsupportedEntries: readonly string[];
    };

export type FrameworkGovernanceFactForKind<
  Kind extends FrameworkGovernanceProofFacts['kind'],
> = Extract<FrameworkGovernanceProofFacts, { kind: Kind }>;
