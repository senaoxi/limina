import type { CoreWorkItem } from '../../domain/analysis/core-collection';
import type { ProjectDependencyCaches } from '../project-dependencies/contracts';
import type { SemanticSourceRelation } from './types';

export interface CoreCollectionRun {
  closed: boolean;
  readonly work: Map<string, CoreWorkItem>;
  readonly failureIds: Set<string>;
  readonly facts: SemanticSourceRelation[];
  transaction: 'not-requested' | 'blocked' | 'completed' | 'failed';
  readonly transactionFailures: string[];
}

export function coreCollectionRun(
  caches: ProjectDependencyCaches,
): CoreCollectionRun {
  return (caches.coreCollectionRun ??= {
    closed: false,
    work: new Map(),
    failureIds: new Set(),
    facts: [],
    transaction: 'not-requested',
    transactionFailures: [],
  });
}

export function recordCoreWork(
  caches: ProjectDependencyCaches,
  item: Omit<CoreWorkItem, 'id'>,
): void {
  const id = JSON.stringify([item.configPath, item.phase]);
  coreCollectionRun(caches).work.set(id, { ...item, id });
}

/**
Begin a new attempt without inheriting a previous transaction's completion.
*/
export function beginCoreCollection(caches: ProjectDependencyCaches): void {
  caches.coreCollectionRun = undefined;
  caches.nativeObservations = new Map();
  caches.nativeSourceEvidence = undefined;
  coreCollectionRun(caches);
}
