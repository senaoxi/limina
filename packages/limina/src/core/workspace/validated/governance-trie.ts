import type { WorkspaceRegionBoundary } from '../regions';
import type {
  WorkspaceIndexMetricsRecorder,
  WorkspacePackageIdentity,
  WorkspacePathClassification,
} from './types';

export interface GovernanceTrieNode {
  readonly segment: string;
  children: GovernanceTrieNode | Map<string, GovernanceTrieNode> | undefined;
  owner: WorkspacePackageIdentity | null;
  boundary: WorkspaceRegionBoundary | null;
}

export interface GovernanceTrieEvent {
  activation?: WorkspacePackageIdentity;
  cuts?: Map<string, WorkspaceRegionBoundary>;
}

export type GovernanceTrieEvents = Map<GovernanceTrieNode, GovernanceTrieEvent>;

export function createGovernanceTrieNode(segment: string): GovernanceTrieNode {
  // A unary edge still consumes exactly one segment. Only branching needs a
  // Map; source-directory depth must not allocate retained governance nodes.
  return { boundary: null, children: undefined, owner: null, segment };
}

function pathSegments(canonicalPath: string): string[] {
  const withoutTrailingSeparator = canonicalPath.endsWith('/')
    ? canonicalPath.slice(0, -1)
    : canonicalPath;
  // Keep '' for POSIX roots and the drive for Windows. The synthetic root is
  // independent of config.rootDir, including for external activated packages.
  return withoutTrailingSeparator.split('/');
}

function findSingleChild(
  child: GovernanceTrieNode | undefined,
  segment: string,
): GovernanceTrieNode | undefined {
  return child?.segment === segment ? child : undefined;
}

function findChild(
  node: GovernanceTrieNode,
  segment: string,
): GovernanceTrieNode | undefined {
  if (node.children instanceof Map) return node.children.get(segment);
  return findSingleChild(node.children, segment);
}

function attachChild(
  node: GovernanceTrieNode,
  child: GovernanceTrieNode,
): void {
  const children = node.children;
  if (children === undefined) node.children = child;
  else if (children instanceof Map) children.set(child.segment, child);
  else {
    node.children = new Map([
      [children.segment, children],
      [child.segment, child],
    ]);
  }
}

function getOrCreateChild(
  node: GovernanceTrieNode,
  segment: string,
): GovernanceTrieNode {
  const existing = findChild(node, segment);
  if (existing !== undefined) return existing;
  const child = createGovernanceTrieNode(segment);
  attachChild(node, child);
  return child;
}

export function insertGovernancePath(
  root: GovernanceTrieNode,
  canonicalPath: string,
): GovernanceTrieNode {
  let node = root;
  for (const segment of pathSegments(canonicalPath)) {
    node = getOrCreateChild(node, segment);
  }
  return node;
}

export function getGovernanceEvent(
  events: GovernanceTrieEvents,
  node: GovernanceTrieNode,
): GovernanceTrieEvent {
  let event = events.get(node);
  if (event === undefined) {
    event = {};
    events.set(node, event);
  }
  return event;
}

function restoreCut(
  activeCuts: Map<string, WorkspaceRegionBoundary>,
  owner: string,
  previous: WorkspaceRegionBoundary | undefined,
): void {
  if (previous === undefined) activeCuts.delete(owner);
  else activeCuts.set(owner, previous);
}

function pushCuts(
  cuts: ReadonlyMap<string, WorkspaceRegionBoundary>,
  activeCuts: Map<string, WorkspaceRegionBoundary>,
): () => void {
  const previousCuts = new Map<string, WorkspaceRegionBoundary | undefined>();
  for (const [owner, boundary] of cuts) {
    previousCuts.set(owner, activeCuts.get(owner));
    activeCuts.set(owner, boundary);
  }
  return () => {
    for (const [owner, previous] of previousCuts)
      restoreCut(activeCuts, owner, previous);
  };
}

function applyCuts(
  event: GovernanceTrieEvent | undefined,
  activeCuts: Map<string, WorkspaceRegionBoundary>,
): (() => void) | undefined {
  const cuts = event?.cuts;
  if (cuts === undefined) return undefined;
  return pushCuts(cuts, activeCuts);
}

function findActiveBoundary(
  identity: WorkspacePackageIdentity | null,
  activeCuts: ReadonlyMap<string, WorkspaceRegionBoundary>,
): WorkspaceRegionBoundary | null {
  if (identity === null) return null;
  return activeCuts.get(identity.canonicalDirectory) ?? null;
}

function childNodes(node: GovernanceTrieNode): Iterable<GovernanceTrieNode> {
  if (node.children instanceof Map) return node.children.values();
  return node.children === undefined ? [] : [node.children];
}

function activatedIdentity(
  event: GovernanceTrieEvent | undefined,
  inherited: WorkspacePackageIdentity | null,
): WorkspacePackageIdentity | null {
  return event?.activation ?? inherited;
}

interface PrecomputeState {
  activeCuts: Map<string, WorkspaceRegionBoundary>;
  events: GovernanceTrieEvents;
  identity: WorkspacePackageIdentity | null;
}

function precomputeNode(
  node: GovernanceTrieNode,
  state: PrecomputeState,
): void {
  const event = state.events.get(node);
  const identity = activatedIdentity(event, state.identity);
  const restore = applyCuts(event, state.activeCuts);
  // Activation precedes same-root cuts. Keep attribution after a cut, so a
  // deeper cut of that owner still wins and another activation can re-enter.
  // Canonical relocation can also put an owner's cut above its activation.
  node.boundary = findActiveBoundary(identity, state.activeCuts);
  assignOwner(node, identity);
  for (const child of childNodes(node)) {
    precomputeNode(child, { ...state, identity });
  }
  restore?.();
}

function assignOwner(
  node: GovernanceTrieNode,
  identity: WorkspacePackageIdentity | null,
): void {
  node.owner = node.boundary === null ? identity : null;
}

export function precomputeGovernanceState(
  root: GovernanceTrieNode,
  events: GovernanceTrieEvents,
): void {
  precomputeNode(root, { activeCuts: new Map(), events, identity: null });
  // Neither construction events nor owner-attribution stacks escape into the
  // index. Effective owner/boundary live inline, without another object/node.
}

function recordSegmentVisit(
  metrics: WorkspaceIndexMetricsRecorder | undefined,
): void {
  metrics?.record({
    kind: 'package-boundary',
    name: 'workspace-path-trie-segment-visit',
    provider: 'workspace-path-index',
  });
}

function findDeepestNode(options: {
  canonicalPath: string;
  metrics?: WorkspaceIndexMetricsRecorder;
  root: GovernanceTrieNode;
}): GovernanceTrieNode {
  let node = options.root;
  for (const segment of pathSegments(options.canonicalPath)) {
    recordSegmentVisit(options.metrics);
    const child = findChild(node, segment);
    if (child === undefined) break;
    node = child;
  }
  return node;
}

export function classifyGovernancePath(options: {
  canonicalPath: string;
  metrics?: WorkspaceIndexMetricsRecorder;
  root: GovernanceTrieNode;
}): WorkspacePathClassification {
  const node = findDeepestNode(options);
  return {
    boundary: node.boundary,
    canonicalPath: options.canonicalPath,
    package: node.owner?.package ?? null,
  };
}
