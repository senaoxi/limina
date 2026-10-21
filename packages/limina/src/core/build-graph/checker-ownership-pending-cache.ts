import type { CheckerDependencyFact } from './checker-ownership-types';

export interface PendingOwnershipEvidence {
  failures?: string[];
  facts: CheckerDependencyFact[];
  problems: string[];
}

export function clonePendingOwnershipEvidence(
  value: PendingOwnershipEvidence,
): PendingOwnershipEvidence {
  return {
    facts: value.facts.map((fact) => ({
      ...fact,
      referenceRequirement:
        fact.referenceRequirement == null
          ? fact.referenceRequirement
          : { ...fact.referenceRequirement },
      importRecord: {
        ...fact.importRecord,
        locator: { ...fact.importRecord.locator },
      },
    })),
    problems: [...value.problems],
    failures: value.failures === undefined ? undefined : [...value.failures],
  };
}

export function getCachedPendingEvidence(options: {
  cache?: Map<string, unknown>;
  cacheKey: string;
}): PendingOwnershipEvidence | undefined {
  const cached = options.cache?.get(options.cacheKey) as
    | PendingOwnershipEvidence
    | undefined;
  return cached === undefined
    ? undefined
    : clonePendingOwnershipEvidence(cached);
}

export function storePendingEvidence(options: {
  cache?: Map<string, unknown>;
  cacheKey: string;
  evidence: PendingOwnershipEvidence;
}): void {
  options.cache?.set(
    options.cacheKey,
    clonePendingOwnershipEvidence(options.evidence),
  );
}
