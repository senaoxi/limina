import type { AnalysisReadDescriptor } from '#utils/analysis-input';
import type { NativeEvidenceSnapshot } from '../../domain/analysis/native-evidence';
import type { LockedSemanticAuthority } from '../build-graph/checker-ownership-types';
import type { ImportRecord } from '../import-analysis/records';
import type { TypeScriptSemanticProject } from '../typescript-semantic/contracts';
import type { DeclarationEntry } from '../typescript-semantic/declaration-closure';
import type { NativeDependencyFact } from '../typescript-semantic/dependency-fact';
import type { FileDependencyFacts } from '../typescript-semantic/file-dependency-facts';
import type { NativeContextInventory } from '../typescript-semantic/native-context-inventory';
import type { TypeEnvironmentRecord } from './type-environment';
import type { VueContextRecord } from './vue-contracts';

export const ANALYSIS_ADAPTER = 'analysis-facts-v1';
export const ANALYSIS_SCHEMA = 19;

export interface InputDependency {
  inputId: string;
  expectedVersion: string;
}

export type InputKind =
  | 'config-mtime'
  | 'affecting-mtime'
  | 'content'
  | 'file'
  | 'directory'
  | 'directories'
  | 'entries'
  | 'realpath'
  | 'binding'
  | 'manifest'
  | 'type-packages'
  | 'directory-identity'
  | 'tree'
  | 'bytes';

export interface AnalysisInput {
  path: string;
  kind: InputKind;
  version: string;
  contentStamp?: string;
  textVersions?: { utf8: string; typescript?: string };
}

export interface ResolutionRecord {
  contextId: string;
  file: string;
  request: unknown;
  targetOwners?: string[] | null;
  result: unknown;
  dependencies: InputDependency[];
  coverage: 'complete' | 'unknown';
}

export interface ImporterRecord {
  contextId: string;
  filePath: string;
  sourceVersion: string;
  environmentVersion: string;
  membershipVersion: string;
  dependencies: InputDependency[];
  queryIds: string[];
  occurrences: ImportRecord[];
  facts: Record<string, NativeDependencyFact>;
  coverage: 'complete' | 'unknown';
}

export interface ProjectRecord {
  roots: string[];
  members: string[];
  environment: string[];
  references: unknown;
}

export interface NativeContextRecord {
  native?: {
    snapshot: NativeEvidenceSnapshot;
    inventory: NativeContextInventory;
    queryReceipts: Record<string, string>;
    discovery: DiscoveryRecord[];
    boundaryIdentity: string;
  };
  typeEntries: DeclarationEntry[];
  collection?: {
    adapter: 'native-requests-v1';
    mode: 'programless' | 'compatibility';
    reason?: string;
  };
  queryIds: string[];
  sharedEnvironment: {
    dependencies: InputDependency[];
    queryIds: string[];
    version: string;
  };
  project: Pick<
    TypeScriptSemanticProject,
    | 'configPath'
    | 'fileNames'
    | 'options'
    | 'projectReferences'
    | 'admissionMode'
    | 'analysisBinding'
    | 'compilationObligationScope'
    | 'sourceConfigPath'
  >;
  environment: TypeEnvironmentRecord;
  dependencies: InputDependency[];
  boundary: [string, boolean][];
  sources: Record<string, string | null>;
  complete: boolean;
}

export interface DiscoveryRecord {
  key: string;
  path: string;
  descriptor: AnalysisReadDescriptor;
  version: string;
  binding: string;
  configStamp?: string;
}

export interface SourceConfigAuthority
  extends Omit<LockedSemanticAuthority, 'kind'> {
  provider: string;
  toolchain: string;
}

export interface SourceConfigProjectionRecord {
  data: string;
  reads: DiscoveryRecord[];
  integrity: string;
}

export interface SourceConfigRecord {
  authority: SourceConfigAuthority;
  projections: Record<string, SourceConfigProjectionRecord>;
}

export interface ConfigModuleFile {
  path: string;
  logicalPath?: string;
  logicalBinding?: string;
  role: 'module' | 'anchor' | 'dependency';
  binding: string;
  metadata: {
    kind: 'file' | 'missing';
    mtimeMs?: number;
    ctimeMs?: number;
    size?: number;
    dev?: number;
    ino?: number;
    mode?: number;
  };
  contentHash: string | null;
  format: string | null;
  sourceKind?: 'disk' | 'loader';
  loadedSource?: {
    contentHash: string;
  };
}

export interface ConfigResolution {
  parentURL: string;
  specifier: string;
  resolvedURL: string;
  conditions: string[];
  importAttributes: Record<string, string>;
  requestBinding?: { path: string; binding: string };
}

export interface ConfigFileDependency {
  path: string;
  resolvedPath: string;
  binding: string;
}

export interface ConfigModuleSnapshot {
  loader: string;
  files: ConfigModuleFile[];
  resolutions: ConfigResolution[];
  complete: boolean;
  dependencies: ConfigFileDependency[];
  otherUnknownReasons: string[];
}

export interface PackageScopeSnapshot {
  manifests: Record<
    string,
    {
      directory: string;
      role: 'active' | 'extended' | 'boundary';
      version: string;
    }
  >;
  configs: Record<string, { scope: string; role: 'source' | 'solution' }>;
}

export interface AnalysisSnapshot {
  header: {
    schema: typeof ANALYSIS_SCHEMA;
    implementation: string;
    identity: string;
    configVersion: string | null;
    revision: string;
    baselineTime?: number;
    packageScopes: PackageScopeSnapshot;
  };
  configModules: ConfigModuleSnapshot;
  inputs: Record<string, AnalysisInput>;
  queries: Record<string, ResolutionRecord>;
  runtimeQueries: Record<string, ResolutionRecord>;
  importers: Record<string, ImporterRecord>;
  files: Record<string, FileDependencyFacts>;
  projects: Record<string, ProjectRecord>;
  contexts: Record<string, NativeContextRecord>;
  vueContexts: Record<string, VueContextRecord>;
  sourceConfigs: Record<string, SourceConfigRecord>;
}

export interface AnalysisCacheMetrics extends Record<string, number> {
  probes: number;
  probeMs: number;
  reads: number;
  readMs: number;
  hashes: number;
  hashMs: number;
  resolverCalls: number;
  queryHits: number;
  factQueries: number;
  factHits: number;
  fallbacks: number;
}

export { AnalysisInputDriftError } from '#utils/analysis-input-drift';
