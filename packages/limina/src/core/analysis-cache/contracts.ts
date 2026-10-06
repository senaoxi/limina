import type { ImportRecord } from '../import-analysis/records';
import type { NativeDependencyFact } from '../typescript-semantic/dependency-fact';

export const ANALYSIS_ADAPTER = 'native-typescript-6.0.3-v1';

export interface InputDependency {
  inputId: string;
  expectedVersion: string;
}

export type InputKind =
  | 'content'
  | 'file'
  | 'directory'
  | 'entries'
  | 'realpath'
  | 'imports'
  | 'exports';

export interface AnalysisInput {
  path: string;
  kind: InputKind;
  version: string;
  observedMtime?: number;
  verifiedThrough?: number;
  text?: string;
}

export interface ResolutionRecord {
  contextId: string;
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

export interface AnalysisSnapshot {
  header: {
    schema: 1;
    implementation: string;
    identity: string;
    revision: string;
  };
  inputs: Record<string, AnalysisInput>;
  queries: Record<string, ResolutionRecord>;
  importers: Record<string, ImporterRecord>;
  projects: Record<string, ProjectRecord>;
  contributions: Record<string, ReferenceContribution[]>;
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
