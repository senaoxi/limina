import { currentProfile } from '../../application/analysis/observability';
import type { CoreWorkItem } from '../../domain/analysis/core-collection';
import type { ProjectDependencyCaches } from '../project-dependencies/contracts';
import { observationErrorDetail } from '../typescript-semantic/native-observation-failure';
import { retainAnalysisFailure } from './analysis-failure';
import { nativeDependencyTarget } from './checker-ownership-fact-qualification';
import type {
  CheckerDependencyFact,
  TypeConfigOwnershipState,
} from './checker-ownership-types';
import { coreCollectionRun, recordCoreWork } from './core-collection-run';
import type { FileOwnerLookup } from './file-owner-lookup';
import type { SemanticSourceRelation } from './types';

interface ProjectFacts {
  failures?: string[];
  facts: CheckerDependencyFact[];
  problems: string[];
}
interface WorkInput {
  caches: ProjectDependencyCaches;
  state: TypeConfigOwnershipState;
  membership: FileOwnerLookup;
  collect: () => ProjectFacts;
}
export function collectIndependentCoreWork(input: WorkInput): ProjectFacts {
  const item = workItem(input);
  const observer = currentProfile();
  if (item.eligibility === 'unavailable') {
    recordCoreWork(input.caches, item);
    if (observer !== undefined) {
      const project = observer.project(item.configPath);
      observer.notRun(
        'locked-project-dependencies',
        ['project', project],
        'authority-unavailable',
      );
    }
    return { facts: [], problems: [] };
  }
  if (observer === undefined) return executeWork(input, item);
  const project = observer.project(item.configPath);
  const work = observer.start('locked-project-dependencies', [
    'project',
    project,
  ]);
  try {
    const result = observer.inWork(work, () => executeWork(input, item));
    observer.finish(work, result.failures?.length ? 'failed' : 'performed');
    return result;
  } catch (error) {
    observer.finish(work, 'failed');
    throw error;
  }
}
function workItem(input: WorkInput): Omit<CoreWorkItem, 'id'> {
  const authority = input.state.semanticAuthority;
  const reason = unavailableReason(input);
  return {
    configPath: input.state.configPath,
    phase: 'locked',
    family: authority.kind === 'locked' ? authority.family : 'typescript',
    eligibility: reason === undefined ? 'eligible' : 'unavailable',
    execution: 'not-run',
    reason,
  };
}
function unavailableReason(input: WorkInput): string | undefined {
  return input.state.semanticAuthorityUnavailable ?? missingLock(input);
}
function missingLock(input: WorkInput): string | undefined {
  return input.state.semanticAuthority.kind === 'locked'
    ? undefined
    : 'authority-unavailable';
}
function executeWork(
  input: WorkInput,
  item: Omit<CoreWorkItem, 'id'>,
): ProjectFacts {
  recordCoreWork(input.caches, item);
  try {
    return completeWork(input, item);
  } catch (error) {
    const reason = observationErrorDetail(error);
    recordCoreWork(input.caches, { ...item, execution: 'failed', reason });
    retainAnalysisFailure(input.caches, error, item.configPath);
    return { facts: [], problems: [], failures: [reason] };
  }
}
function completeWork(
  input: WorkInput,
  item: Omit<CoreWorkItem, 'id'>,
): ProjectFacts {
  const result = input.collect();
  recordCoreWork(input.caches, {
    ...item,
    execution: workExecution(result),
    reason: result.failures?.join('\n\n'),
  });
  retainRelations(input, result.facts);
  return result;
}
function workExecution(result: ProjectFacts): CoreWorkItem['execution'] {
  return result.failures?.length ? 'failed' : 'completed';
}
function retainRelations(
  input: WorkInput,
  facts: readonly CheckerDependencyFact[],
): void {
  const retained = coreCollectionRun(input.caches).facts;
  for (const relation of projectCoreRelations(facts, input.membership))
    retained.push(relation);
}

export function* projectCoreRelations(
  facts: readonly CheckerDependencyFact[],
  membership: FileOwnerLookup,
): IterableIterator<SemanticSourceRelation> {
  for (const fact of facts) {
    const target = relationTarget(fact, membership);
    if (target === null) continue;
    yield {
      fromConfigPath: fact.consumerConfigPath,
      toConfigPath: target,
      file: fact.importRecord.filePath,
      specifier: fact.importRecord.specifier,
    };
  }
}
function relationTarget(
  fact: CheckerDependencyFact,
  membership: FileOwnerLookup,
): string | null {
  const native = nativeDependencyTarget(fact);
  const target =
    native === undefined ? frameworkTarget(fact, membership) : native;
  return target === fact.consumerConfigPath ? null : target;
}
function frameworkTarget(
  fact: CheckerDependencyFact,
  membership: FileOwnerLookup,
): string | null {
  return fact.referenceRequirement === null || fact.physicalTargetPath === null
    ? null
    : uniqueTarget(membership.get(fact.physicalTargetPath));
}
function uniqueTarget(owners: readonly string[] | undefined): string | null {
  return owners?.length === 1 ? owners[0]! : null;
}
