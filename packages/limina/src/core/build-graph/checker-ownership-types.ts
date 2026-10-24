import type { CheckerName } from '#config/runner';
import type { ImportRecord } from '#core/import-analysis/runner';
import type { DeclarationContextDecision } from '../../domain/analysis/declaration-context';
import type { NativeEvidenceOrigin } from '../../domain/analysis/native-context';
import type { NativeCoverage } from '../../domain/analysis/native-coverage';
import type {
  DeclarationReferenceRequirement,
  NativeDependencyFact,
} from '../typescript-semantic/dependency-fact';

export type CheckerOwner =
  | { kind: 'pending' }
  | { checker: CheckerName; kind: 'resolved' };

export type SemanticFamily = 'astro' | 'svelte' | 'typescript' | 'vue';

export type SemanticAuthoritySource =
  | 'explicit'
  | 'config'
  | 'root-file'
  | 'dependency';

export interface LockedSemanticAuthority {
  family: SemanticFamily;
  kind: 'locked';
  source: SemanticAuthoritySource;
}

export type SemanticAuthority =
  | LockedSemanticAuthority
  | { baseline: 'typescript'; kind: 'pending' };

export type CheckerEvidenceSource =
  | 'explicit'
  | 'config'
  | 'root-file'
  | 'dependency'
  | 'build-closure'
  | 'vue-promotion'
  | 'solution-constraint'
  | 'fallback';

export interface CheckerEvidence {
  checker: CheckerName;
  configPath: string;
  detail: string;
  source: CheckerEvidenceSource;
}

export interface TypeConfigOwnershipState {
  semanticAuthorityUnavailable?: string;
  authoritativeOwner?: CheckerName;
  configPath: string;
  constraintCandidates: Map<CheckerName, CheckerEvidence[]>;
  evidence: CheckerEvidence[];
  finalOwner?: CheckerName;
  frozenSemanticAuthority?: LockedSemanticAuthority;
  kind: 'type';
  localOwner: CheckerOwner;
  semanticAuthority: SemanticAuthority;
}

export interface SolutionOwnershipState {
  configPath: string;
  constraintCandidates: Map<CheckerName, CheckerEvidence[]>;
  declaredConstraint?: CheckerName;
  finalOwner?: CheckerName;
  kind: 'solution';
  leafConfigPaths: string[];
}

export interface CheckerDependencyFact {
  frameworkCandidate?: PhysicalFrameworkCandidate;
  nativeEvidence?: NativeDependencyFact['nativeEvidence'];
  referenceRequirement?: DeclarationReferenceRequirement | null;
  consumerConfigPath: string;
  importRecord: ImportRecord;
  physicalTargetPath: string | null;
  physicalTargetProvenance:
    | 'checker-source'
    | 'pending-framework-candidate'
    | null;
  typeEvidenceKind:
    | 'ambient'
    | 'checker-source'
    | 'concrete-declaration'
    | 'missing'
    | 'unobserved';
}

export interface PhysicalFrameworkCandidate {
  origin: NativeEvidenceOrigin;
  coverage: NativeCoverage;
  observer: 'oxc-physical-candidate-v1';
  family: Exclude<SemanticFamily, 'typescript'>;
  owningConfigPath: string;
  targetPath: string;
}

export interface CheckerOwnershipPlan {
  declarationContexts?: DeclarationContextDecision[];
  dependencyFactPhase?: 'selection' | 'locked';
  ownershipSelectionFacts?: readonly CheckerDependencyFact[];
  dependencyFacts: CheckerDependencyFact[];
  entryOwnerByConfigPath: Map<string, CheckerName>;
  solutions: Map<string, SolutionOwnershipState>;
  typeConfigs: Map<string, TypeConfigOwnershipState>;
}
