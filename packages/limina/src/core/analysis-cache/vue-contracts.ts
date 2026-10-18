import type { VueProjectSemanticIdentity } from '#checkers';
import type {
  FrameworkSemanticDependencyPreparation,
  FrameworkSemanticEvidence,
} from '../framework-semantic/contracts';
import type { ImportRecord } from '../import-analysis/records';
import type { TypeEvidence } from '../type-evidence/cache';
import type { VueDependencyObservation } from '../vue-semantic/dependency-observation';
import type { InputDependency } from './contracts';
import type { DataNode } from './data-codec';
import type { TypeEnvironmentRecord } from './installation-environment';

export interface VueQueryResults {
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
  collect: () => VueQueryResults[K] | undefined;
}
export interface VueQueryRecord {
  kind: VueQueryKind;
  data: DataNode;
}
export interface VueContextRecord {
  adapter: 'vue-3.2.4-v2';
  project: Pick<VueProjectSemanticIdentity, 'configPath' | 'projectRootDir'> & {
    extensions: string[];
  };
  identity: DataNode;
  dependencies: InputDependency[];
  environment: TypeEnvironmentRecord;
  members: string[];
  generated: Record<string, string>;
  queries: Record<string, VueQueryRecord>;
  queryIds: string[];
  complete: boolean;
}
