import type { ResolvedLiminaConfig } from '#config/runner';
import {
  isNamedWorkspacePackage,
  type WorkspacePackage,
} from '#core/workspace/actions';
import { compareCodeUnits } from '#utils/collections';
import { toRelativePath } from '#utils/path';
import type {
  DependencyGraphEdge,
  DependencyGraphEvidence,
  DependencyGraphNode,
} from './types';

export function createPackageNodeId(packageName: string): string {
  return `pkg:${packageName}`;
}

export function createNodes(
  config: ResolvedLiminaConfig,
  workspacePackages: WorkspacePackage[],
): DependencyGraphNode[] {
  return workspacePackages
    .filter(isNamedWorkspacePackage)
    .map((workspacePackage) => ({
      id: createPackageNodeId(workspacePackage.name),
      kind: 'package' as const,
      name: workspacePackage.name,
      path: toRelativePath(config.rootDir, workspacePackage.directory),
    }))
    .sort((left, right) => compareCodeUnits(left.id, right.id));
}

function createEdgeKey(
  edge: Pick<DependencyGraphEdge, 'from' | 'kind' | 'to'>,
): string {
  return `${edge.kind}\0${edge.from}\0${edge.to}`;
}

function createEvidenceKey(evidence: DependencyGraphEvidence): string {
  return `${evidence.importer}\0${evidence.specifier}\0${evidence.resolvedPath}`;
}

function hasEvidence(
  edge: DependencyGraphEdge,
  evidence: DependencyGraphEvidence,
): boolean {
  const evidenceKey = createEvidenceKey(evidence);
  return edge.evidence.some(
    (candidate) => createEvidenceKey(candidate) === evidenceKey,
  );
}

function getOrCreateEdge(
  edgesByKey: Map<string, DependencyGraphEdge>,
  edge: Omit<DependencyGraphEdge, 'evidence'>,
): DependencyGraphEdge {
  return (
    edgesByKey.get(createEdgeKey(edge)) ?? {
      evidence: [],
      from: edge.from,
      kind: edge.kind,
      to: edge.to,
    }
  );
}

export function addEdge(
  edgesByKey: Map<string, DependencyGraphEdge>,
  edge: Omit<DependencyGraphEdge, 'evidence'> & {
    evidence: DependencyGraphEvidence;
  },
): void {
  const currentEdge = getOrCreateEdge(edgesByKey, edge);

  if (!hasEvidence(currentEdge, edge.evidence)) {
    currentEdge.evidence.push(edge.evidence);
  }

  edgesByKey.set(createEdgeKey(edge), currentEdge);
}

function compareEvidence(
  left: DependencyGraphEvidence,
  right: DependencyGraphEvidence,
): number {
  const importerOrder = compareCodeUnits(left.importer, right.importer);

  if (importerOrder !== 0) {
    return importerOrder;
  }

  const specifierOrder = compareCodeUnits(left.specifier, right.specifier);
  return specifierOrder === 0
    ? compareCodeUnits(left.resolvedPath, right.resolvedPath)
    : specifierOrder;
}

function sortEdgeEvidence(edge: DependencyGraphEdge): DependencyGraphEdge {
  return { ...edge, evidence: [...edge.evidence].sort(compareEvidence) };
}

function compareEdges(
  left: DependencyGraphEdge,
  right: DependencyGraphEdge,
): number {
  const fromOrder = compareCodeUnits(left.from, right.from);

  if (fromOrder !== 0) {
    return fromOrder;
  }

  const toOrder = compareCodeUnits(left.to, right.to);
  return toOrder === 0 ? compareCodeUnits(left.kind, right.kind) : toOrder;
}

export function sortEdges(edges: DependencyGraphEdge[]): DependencyGraphEdge[] {
  return edges.map(sortEdgeEvidence).sort(compareEdges);
}
