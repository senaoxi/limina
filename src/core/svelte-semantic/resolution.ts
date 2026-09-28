import type {
  FrameworkSemanticFailureStage,
  PreparedDependencyFact,
} from '../framework-semantic/contracts';
import type { ImportRecord } from '../import-analysis/runner';
import type { SvelteSemanticContextManager } from './context';
import type { SvelteSemanticProject } from './types';

export type SvelteSemanticResolution =
  | { fact: PreparedDependencyFact; kind: 'resolved' }
  | {
      kind: 'unsupported';
      reason: string;
      stage: FrameworkSemanticFailureStage;
    };

function sameOccurrence(
  fact: PreparedDependencyFact,
  importRecord: ImportRecord,
): boolean {
  return (
    fact.importRecord.locator.sourceStart ===
      importRecord.locator.sourceStart &&
    fact.importRecord.locator.sourceEnd === importRecord.locator.sourceEnd &&
    fact.importRecord.kind === importRecord.kind
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function selectPreparedFact(
  facts: readonly PreparedDependencyFact[],
  importRecord: ImportRecord,
): SvelteSemanticResolution {
  const matches = facts.filter((fact) => sameOccurrence(fact, importRecord));
  if (matches.length !== 1) {
    return {
      kind: 'unsupported',
      reason:
        'Svelte source occurrence did not identify one prepared generated dependency fact.',
      stage: 'source-map-mismatch',
    };
  }
  return { fact: matches[0]!, kind: 'resolved' };
}

function resolvePreparedImport(options: {
  importRecord: ImportRecord;
  manager: SvelteSemanticContextManager;
  project: SvelteSemanticProject;
}): SvelteSemanticResolution {
  const preparation = options.manager
    .acquire(options.project)
    .prepare(options.importRecord.filePath);
  if (preparation.kind === 'unsupported') return preparation;
  return selectPreparedFact(preparation.facts, options.importRecord);
}

export function resolveSvelteSemanticImport(options: {
  importRecord: ImportRecord;
  manager: SvelteSemanticContextManager;
  project: SvelteSemanticProject;
}): SvelteSemanticResolution {
  try {
    return resolvePreparedImport(options);
  } catch (error) {
    return {
      kind: 'unsupported',
      reason: formatError(error),
      stage: 'context-creation',
    };
  }
}
