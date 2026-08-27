import type { CheckerName } from '#config/runner';
import type { ImportRecord } from '#core/import-analysis/runner';

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
  | { baseline: 'typescript'; kind: 'pending' }
  | LockedSemanticAuthority;

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
    | 'missing';
}

export interface PhysicalFrameworkCandidate {
  family: Exclude<SemanticFamily, 'typescript'>;
  owningConfigPath: string;
  targetPath: string;
}

export interface CheckerOwnershipPlan {
  dependencyFacts: CheckerDependencyFact[];
  entryOwnerByConfigPath: Map<string, CheckerName>;
  solutions: Map<string, SolutionOwnershipState>;
  typeConfigs: Map<string, TypeConfigOwnershipState>;
}
