import type { VueProjectSemanticIdentity } from '#checkers';
import type { CheckerRequestInventory } from '../../domain/analysis/declaration-governance';
import type {
  FrameworkSemanticDependencyPreparation,
  FrameworkSemanticEvidence,
} from '../framework-semantic/contracts';
import type { ImportRecord } from '../import-analysis/records';
import type { TypeEvidence } from '../type-evidence/cache';
import type { DeclarationEntry } from '../typescript-semantic/declaration-closure';
import type { VueDependencyObservation } from '../vue-semantic/dependency-observation';
import type { InputDependency } from './contracts';
import type { DataNode } from './data-codec';
import type { TypeEnvironmentRecord } from './installation-environment';
import type { VUE_ANALYSIS_ADAPTER } from './vue-identity';

export interface VueQueryResults {
  'request-inventory': CheckerRequestInventory;
  'compiler-source': ImportRecord[];
  'type-environment-entries': DeclarationEntry[];
  'support-inputs': { filePath: string; records: ImportRecord[] }[];
  'dependency-observation': VueDependencyObservation;
  preparation: Extract<
    FrameworkSemanticDependencyPreparation,
    { kind: 'supported' }
  >;
  resolution: Omit<FrameworkSemanticEvidence, 'identityId'>;
  evidence: Exclude<TypeEvidence, { kind: 'unsupported-checker' }>;
}
export type VueQueryKind = keyof VueQueryResults;
export interface VueQuery<K extends VueQueryKind> {
  identity: VueProjectSemanticIdentity;
  kind: K;
  request: unknown;
  fromModuleReceipt?: () => VueQueryResults[K] | undefined;
  collect: () => VueQueryResults[K] | undefined;
}
export interface VueQueryRecord {
  kind: VueQueryKind;
  data: DataNode;
}
export interface VueModuleRecord {
  members: string[];
  dependencies: InputDependency[];
  result: DataNode;
  targetOwners: string[] | null;
}
export interface VueContextRecord {
  adapter: typeof VUE_ANALYSIS_ADAPTER;
  project: Pick<VueProjectSemanticIdentity, 'configPath' | 'projectRootDir'> & {
    declarationLoading?: VueProjectSemanticIdentity['declarationLoading'];
    extensions: string[];
    outputProjection?: VueProjectSemanticIdentity['outputProjection'];
  };
  identity: DataNode;
  dependencies: InputDependency[];
  environment: TypeEnvironmentRecord;
  members: string[];
  generated: Record<string, string>;
  queries: Record<string, VueQueryRecord>;
  queryIds: string[];
  moduleResolutions: Record<string, VueModuleRecord>;
  moduleContextId: string;
  complete: boolean;
}
