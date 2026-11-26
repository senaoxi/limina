import type { CheckerName } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import type { CoreWorkItem } from '../../domain/analysis/core-collection';
import type { DeclarationContextDecision } from '../../domain/analysis/declaration-context';
import type { ProjectDependencyCaches } from '../project-dependencies/contracts';
import type { SemanticSourceRelation } from './types';

export interface FrameworkInferenceAmbiguity {
  readonly sourceConfigPath: string;
  readonly checkers: readonly CheckerName[];
}

export interface CoreCollectionRun {
  frameworkInferenceAmbiguities?: readonly FrameworkInferenceAmbiguity[];
  declarationContexts?: DeclarationContextDecision[];
  closed: boolean;
  readonly work: Map<string, CoreWorkItem>;
  readonly failureIds: Set<string>;
  readonly facts: SemanticSourceRelation[];
  transaction: 'not-requested' | 'blocked' | 'completed' | 'failed';
  readonly transactionFailures: string[];
}

export function recordFrameworkInferenceAmbiguities(
  caches: ProjectDependencyCaches,
  ambiguities: readonly FrameworkInferenceAmbiguity[],
): void {
  const byConfig = new Map<string, Set<CheckerName>>();
  for (const ambiguity of ambiguities) {
    const checkers = byConfig.get(ambiguity.sourceConfigPath) ?? new Set();
    for (const checker of ambiguity.checkers) checkers.add(checker);
    byConfig.set(ambiguity.sourceConfigPath, checkers);
  }
  coreCollectionRun(caches).frameworkInferenceAmbiguities = [...byConfig]
    .filter(([, checkers]) => checkers.size > 1)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([sourceConfigPath, checkers]) => ({
      sourceConfigPath,
      checkers: [...checkers].sort(compareCodeUnits),
    }));
}

export function readFrameworkInferenceAmbiguities(
  caches: ProjectDependencyCaches,
): readonly FrameworkInferenceAmbiguity[] | undefined {
  return caches.coreCollectionRun?.frameworkInferenceAmbiguities;
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
  caches.declarationContextPolicy = undefined;
  caches.referenceFacts?.clear();
  caches.nativeObservations = new Map();
  caches.sourceConfigCoverage = undefined;
  caches.supplementalAssessments = undefined;
  coreCollectionRun(caches);
}
