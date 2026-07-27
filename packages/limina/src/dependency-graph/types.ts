import type { AnalysisProviderSet } from '#core';

export type DependencyGraphView = 'all' | 'artifact' | 'source';
export type DependencyGraphEdgeKind = 'artifact' | 'source';

export interface DependencyGraphNode {
  id: string;
  kind: 'package';
  name: string;
  path: string;
}

export interface DependencyGraphEvidence {
  importer: string;
  resolvedPath: string;
  specifier: string;
}

export interface DependencyGraphEdge {
  evidence: DependencyGraphEvidence[];
  from: string;
  kind: DependencyGraphEdgeKind;
  to: string;
}

export interface DependencyGraphDocument {
  edges: DependencyGraphEdge[];
  nodes: DependencyGraphNode[];
  rootDir: string;
  schemaVersion: 1;
  view: DependencyGraphView;
}

export interface CollectDependencyGraphOptions {
  providers?: AnalysisProviderSet;
  view?: DependencyGraphView;
}
