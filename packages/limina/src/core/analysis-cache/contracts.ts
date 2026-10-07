import type { AnalysisReadDescriptor } from '#utils/analysis-input';
import type { ImportRecord } from '../import-analysis/records';
import type { TypeScriptSemanticProject } from '../typescript-semantic/contracts';
import type { NativeDependencyFact } from '../typescript-semantic/dependency-fact';
import type { DataNode } from './data-codec';
import type { TypeEnvironmentRecord } from './installation-environment';

export const ANALYSIS_ADAPTER = 'native-typescript-6.0.3-v4';

export interface InputDependency {
  inputId: string;
  expectedVersion: string;
}

export type InputKind =
  | 'content'
  | 'file'
  | 'directory'
  | 'directories'
  | 'entries'
  | 'realpath'
  | 'binding'
  | 'tree'
  | 'bytes'
  | 'imports'
  | 'exports';

export interface AnalysisInput {
  path: string;
  kind: InputKind;
  version: string;
  observedMtime?: number;
  verifiedThrough?: number;
  text?: string;
  installedTargets?: string[];
}

export interface ResolutionRecord {
  contextId: string;
  file: string;
  request: unknown;
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

export interface ReferenceContribution {
  occurrence: ImportRecord;
  sourceVersion: string;
  fromChecker: string;
  toChecker: string;
  fromConfigPath: string;
  toConfigPath: string;
  kind: string;
}

export interface NativeContextRecord {
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
}

export interface GraphRecord {
  workspaceVersion: string;
  contextIds: string[];
  dependencies: InputDependency[];
  discovery: DiscoveryRecord[];
  data: DataNode;
}

export interface AnalysisSnapshot {
  header: {
    schema: 3;
    implementation: string;
    identity: string;
    configVersion: string | null;
    revision: string;
  };
  inputs: Record<string, AnalysisInput>;
  queries: Record<string, ResolutionRecord>;
  importers: Record<string, ImporterRecord>;
  projects: Record<string, ProjectRecord>;
  contributions: Record<string, ReferenceContribution[]>;
  contexts: Record<string, NativeContextRecord>;
  graphs: Record<string, GraphRecord>;
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

export class AnalysisInputDriftError extends Error {
  override readonly name = 'AnalysisInputDriftError';
  readonly inputPath: string;
  constructor(inputPath: string) {
    super(`Analysis input changed during analysis: ${inputPath}`);
    this.inputPath = inputPath;
  }
}
