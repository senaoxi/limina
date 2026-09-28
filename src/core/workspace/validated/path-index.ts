import { normalizeAbsolutePath } from '#utils/path';
import type { WorkspacePackage } from '../actions';
import type { WorkspaceRegionBoundary } from '../regions';
import { classifyGovernancePath } from './governance-trie';
import {
  createWorkspacePathIndexState,
  type WorkspacePathIndexState,
} from './path-index-build';
import { canonicalProjectedPathSync } from './shared';
import type {
  ValidatedWorkspaceContext,
  WorkspaceIndexMetricsRecorder,
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
    this.#recordIndexSize('package', this.#state.packageEntryCount);
    this.#recordIndexSize('boundary', this.#state.boundaryEntryCount);
  }

  classifyPath(filePath: string): WorkspacePathClassification {
    const normalizedFilePath = normalizeAbsolutePath(filePath);
    const cached = this.#classificationCache.get(normalizedFilePath);
    if (cached !== undefined) {
      this.#recordClassification('hit', cached);
      return cached;
    }
    const classification = classifyGovernancePath({
      canonicalPath: this.#canonicalProjectedPath(normalizedFilePath),
      metrics: this.#metrics,
      root: this.#state.root,
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
