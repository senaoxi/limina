import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import type { WorkspacePackage } from '../actions';
import type { WorkspaceRegionBoundary } from '../regions';
import {
  createWorkspacePathIndexState,
  type WorkspacePathIndexState,
} from './path-index-build';
import { canonicalProjectedPathSync } from './shared';
import type {
  ValidatedWorkspaceContext,
  WorkspaceIndexMetricsRecorder,
  WorkspacePackageIdentity,
  WorkspacePathClassification,
} from './types';

interface WorkspaceMetricMeasurement {
  count?: number;
  kind: string;
  name: Parameters<WorkspaceIndexMetricsRecorder['record']>[0]['name'];
  provider: string;
}

function recordMetric(
  metrics: WorkspaceIndexMetricsRecorder | undefined,
  measurement: WorkspaceMetricMeasurement,
): void {
  if (metrics === undefined) return;
  metrics.record(measurement);
}

function collectAncestorDirectories(directory: string): string[] {
  const directories: string[] = [];
  let currentDirectory = directory;
  while (true) {
    directories.push(currentDirectory);
    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) return directories;
    currentDirectory = parentDirectory;
  }
}

function recordAncestorVisit(
  metrics: WorkspaceIndexMetricsRecorder | undefined,
): void {
  recordMetric(metrics, {
    kind: 'package-boundary',
    name: 'workspace-path-ancestor-visit',
    provider: 'workspace-path-index',
  });
}

function findNearestIdentity(options: {
  canonicalPath: string;
  identities: ReadonlyMap<string, WorkspacePackageIdentity>;
  metrics?: WorkspaceIndexMetricsRecorder;
}): WorkspacePackageIdentity | undefined {
  for (const directory of collectAncestorDirectories(options.canonicalPath)) {
    recordAncestorVisit(options.metrics);
    const identity = options.identities.get(directory);
    if (identity !== undefined) return identity;
  }
  return undefined;
}

function getBoundaryIndex(
  boundaries: ReadonlyMap<string, WorkspaceRegionBoundary> | undefined,
): ReadonlyMap<string, WorkspaceRegionBoundary> {
  if (boundaries !== undefined) return boundaries;
  return new Map();
}

function findBoundaryInAncestors(options: {
  boundaries: ReadonlyMap<string, WorkspaceRegionBoundary>;
  canonicalPath: string;
  metrics?: WorkspaceIndexMetricsRecorder;
}): WorkspaceRegionBoundary | null {
  for (const directory of collectAncestorDirectories(options.canonicalPath)) {
    recordAncestorVisit(options.metrics);
    const boundary = options.boundaries.get(directory);
    if (boundary !== undefined) return boundary;
  }
  return null;
}

function findNearestBoundary(options: {
  boundaries: ReadonlyMap<string, WorkspaceRegionBoundary> | undefined;
  canonicalPath: string;
  metrics?: WorkspaceIndexMetricsRecorder;
}): WorkspaceRegionBoundary | null {
  const boundaries = getBoundaryIndex(options.boundaries);
  if (boundaries.size === 0) return null;
  return findBoundaryInAncestors({ ...options, boundaries });
}

function createClassification(options: {
  canonicalPath: string;
  metrics?: WorkspaceIndexMetricsRecorder;
  state: WorkspacePathIndexState;
}): WorkspacePathClassification {
  const identity = findNearestIdentity({
    canonicalPath: options.canonicalPath,
    identities: options.state.identityByCanonicalDirectory,
    metrics: options.metrics,
  });
  if (identity === undefined) {
    return {
      boundary: null,
      canonicalPath: options.canonicalPath,
      package: null,
    };
  }
  const boundary = findNearestBoundary({
    boundaries: options.state.boundariesByOwner.get(
      identity.canonicalDirectory,
    ),
    canonicalPath: options.canonicalPath,
    metrics: options.metrics,
  });
  return {
    boundary,
    canonicalPath: options.canonicalPath,
    package: boundary === null ? identity.package : null,
  };
}

function getClassificationMetricName(
  state: 'hit' | 'miss',
): 'workspace-path-classification-hit' | 'workspace-path-classification-miss' {
  return state === 'hit'
    ? 'workspace-path-classification-hit'
    : 'workspace-path-classification-miss';
}

function getCacheMetricName(
  state: 'hit' | 'miss',
): 'provider-cache-hit' | 'provider-cache-miss' {
  return state === 'hit' ? 'provider-cache-hit' : 'provider-cache-miss';
}

function isNegativeClassification(
  classification: WorkspacePathClassification,
): boolean {
  if (classification.package !== null) return false;
  return classification.boundary === null;
}

export class WorkspaceRegionPathIndex {
  readonly packages: readonly WorkspacePackage[];
  readonly rootDir: string;
  readonly #canonicalPathCache = new Map<string, string>();
  readonly #classificationCache = new Map<
    string,
    WorkspacePathClassification
  >();
  readonly #metrics: WorkspaceIndexMetricsRecorder | undefined;
  readonly #state: WorkspacePathIndexState;

  constructor(
    context: ValidatedWorkspaceContext,
    metrics?: WorkspaceIndexMetricsRecorder,
  ) {
    this.#metrics = metrics;
    this.#state = createWorkspacePathIndexState(context, (filePath) =>
      this.#canonicalProjectedPath(filePath),
    );
    this.packages = this.#state.packages;
    this.rootDir = this.#state.rootDir;
    this.#recordIndexSize(
      'package',
      this.#state.identityByCanonicalDirectory.size,
    );
    this.#recordIndexSize('boundary', this.#state.boundaryEntryCount);
  }

  classifyPath(filePath: string): WorkspacePathClassification {
    const normalizedFilePath = normalizeAbsolutePath(filePath);
    const cached = this.#classificationCache.get(normalizedFilePath);
    if (cached !== undefined) {
      this.#recordClassification('hit', cached);
      return cached;
    }
    const classification = createClassification({
      canonicalPath: this.#canonicalProjectedPath(normalizedFilePath),
      metrics: this.#metrics,
      state: this.#state,
    });
    this.#classificationCache.set(normalizedFilePath, classification);
    this.#recordClassification('miss', classification);
    return classification;
  }

  findPackageForPath(filePath: string): WorkspacePackage | null {
    return this.classifyPath(filePath).package;
  }

  findBoundaryForPath(filePath: string): WorkspaceRegionBoundary | null {
    return this.classifyPath(filePath).boundary;
  }

  isInsideActivatedRegion(filePath: string): boolean {
    return this.findPackageForPath(filePath) !== null;
  }

  isSourceConfigPath(filePath: string): boolean {
    if (!this.isInsideActivatedRegion(filePath)) return false;
    return this.#state.sourceConfigIdentities.has(
      this.#canonicalProjectedPath(filePath),
    );
  }

  #canonicalProjectedPath(targetPath: string): string {
    const normalizedTarget = normalizeAbsolutePath(targetPath);
    const cached = this.#canonicalPathCache.get(normalizedTarget);
    if (cached !== undefined) {
      this.#recordCanonicalCache('canonical-path-cache-hit');
      return cached;
    }
    this.#recordCanonicalCache('canonical-path-cache-miss');
    const canonicalPath = canonicalProjectedPathSync(normalizedTarget);
    recordMetric(this.#metrics, {
      kind: 'projected-path',
      name: 'canonical-path',
      provider: 'workspace-path-index',
    });
    this.#canonicalPathCache.set(normalizedTarget, canonicalPath);
    return canonicalPath;
  }

  #recordCanonicalCache(
    name: 'canonical-path-cache-hit' | 'canonical-path-cache-miss',
  ): void {
    recordMetric(this.#metrics, {
      kind: 'projected-path',
      name,
      provider: 'workspace-path-index',
    });
  }

  #recordClassification(
    state: 'hit' | 'miss',
    classification: WorkspacePathClassification,
  ): void {
    recordMetric(this.#metrics, {
      kind: 'package-boundary',
      name: getClassificationMetricName(state),
      provider: 'workspace-path-index',
    });
    recordMetric(this.#metrics, {
      kind: 'package-boundary',
      name: getCacheMetricName(state),
      provider: 'workspace-path-index',
    });
    if (!isNegativeClassification(classification)) return;
    recordMetric(this.#metrics, {
      kind: 'package-boundary',
      name: 'workspace-negative-lookup',
      provider: 'workspace-path-index',
    });
  }

  #recordIndexSize(kind: 'boundary' | 'package', count: number): void {
    recordMetric(this.#metrics, {
      count,
      kind,
      name: 'workspace-directory-index-entry',
      provider: 'workspace-path-index',
    });
  }
}

export function classifyPathWithinContext(options: {
  context: ValidatedWorkspaceContext;
  filePath: string;
  metrics?: WorkspaceIndexMetricsRecorder;
}): WorkspacePathClassification {
  return new WorkspaceRegionPathIndex(
    options.context,
    options.metrics,
  ).classifyPath(options.filePath);
}

export function isPathInsideValidatedPackage(options: {
  context: ValidatedWorkspaceContext;
  filePath: string;
  metrics?: WorkspaceIndexMetricsRecorder;
}): boolean {
  return classifyPathWithinContext(options).package !== null;
}
