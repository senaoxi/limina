import type {
  ImporterRecord,
  NativeContextRecord,
} from '../analysis-cache/contracts';
import { occurrenceKey } from '../analysis-cache/semantic-state';
import type { NativeDependencyFact } from '../typescript-semantic/dependency-fact';
import { createImportRecordIdentity } from '../typescript-semantic/import-record';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import type { StoredGraphData } from './analysis-cache-schema';
import type {
  CheckerDependencyFact,
  CheckerOwnershipPlan,
  SemanticAuthority,
} from './checker-ownership-types';

interface ObservedFact {
  fact: NativeDependencyFact;
  occurrence: CheckerDependencyFact['importRecord'];
}

/**
 * Ownership DTOs cannot grant a qualification absent from a validated fact.
 */
export function hasBoundNativeOwnership(input: {
  graph: StoredGraphData;
  contexts: Readonly<Record<string, NativeContextRecord>>;
  importers: Readonly<Record<string, ImporterRecord>>;
}): boolean {
  const observed = observedFacts(input);
  const plan = input.graph.ownershipPlan;
  return [
    plan.dependencyFactPhase === 'locked',
    plan.dependencyFacts.every((fact) => hasNativeQualification(fact, plan)),
    plan.dependencyFacts.every((fact) => isBoundFact(fact, observed, true)),
    (plan.ownershipSelectionFacts ?? []).every((fact) =>
      isBoundFact(fact, observed, false),
    ),
  ].every(Boolean);
}

function hasNativeQualification(
  fact: CheckerDependencyFact,
  plan: CheckerOwnershipPlan,
): boolean {
  const state = plan.typeConfigs.get(fact.consumerConfigPath);
  return (
    state !== undefined &&
    hasAuthorityQualification(fact, state.semanticAuthority)
  );
}

function hasAuthorityQualification(
  fact: CheckerDependencyFact,
  authority: SemanticAuthority,
): boolean {
  return (
    authority.kind === 'locked' &&
    [authority.family !== 'typescript', fact.nativeEvidence !== undefined].some(
      Boolean,
    )
  );
}

function observedFacts(input: Parameters<typeof hasBoundNativeOwnership>[0]) {
  const sources = new Set(
    Object.values(input.contexts).flatMap((context) =>
      Object.values(context.sources),
    ),
  );
  const facts = [...sources].flatMap((id) =>
    id === null ? [] : importerFacts(input.importers[id]),
  );
  return new Map(
    facts.map((entry) => [entry.fact.nativeEvidence!.requestId, entry]),
  );
}

function importerFacts(importer: ImporterRecord | undefined): ObservedFact[] {
  if (importer === undefined) return [];
  return importer.occurrences.flatMap((occurrence) => {
    const fact = importer.facts[occurrenceKey(occurrence)];
    return fact?.nativeEvidence === undefined ? [] : [{ fact, occurrence }];
  });
}

function isBoundFact(
  fact: CheckerDependencyFact,
  observed: ReadonlyMap<string, ObservedFact>,
  isLocked: boolean,
): boolean {
  const evidence = fact.nativeEvidence;
  if (evidence === undefined) return true;
  const raw = observed.get(evidence.requestId);
  return raw !== undefined && isObservedFact({ fact, raw, isLocked });
}

function isObservedFact(input: {
  fact: CheckerDependencyFact;
  raw: ObservedFact;
  isLocked: boolean;
}): boolean {
  const { fact, raw, isLocked } = input;
  const evidence = fact.nativeEvidence!;
  return [
    nativeFingerprint(evidence) === nativeFingerprint(raw.fact.nativeEvidence),
    createImportRecordIdentity(fact.importRecord) ===
      createImportRecordIdentity(raw.occurrence),
    fact.consumerConfigPath === evidence.origin.context.inputs.config,
    !isLocked || evidence.origin.context.authority.phase === 'locked',
    nativeFingerprint(fact.referenceRequirement ?? null) ===
      nativeFingerprint(raw.fact.referenceRequirement),
    hasPhysicalTarget(fact, raw.fact.referenceRequirement),
  ].every(Boolean);
}

function hasPhysicalTarget(
  fact: CheckerDependencyFact,
  requirement: NativeDependencyFact['referenceRequirement'],
): boolean {
  if (requirement !== null)
    return [
      fact.physicalTargetProvenance === 'checker-source',
      fact.physicalTargetPath === requirement.targetFileName,
    ].every(Boolean);
  return fact.frameworkCandidate === undefined
    ? fact.physicalTargetPath === null
    : hasFrameworkCandidate(fact);
}

function hasFrameworkCandidate(fact: CheckerDependencyFact): boolean {
  const candidate = fact.frameworkCandidate!;
  return [
    fact.physicalTargetPath === candidate.targetPath,
    fact.physicalTargetProvenance === 'pending-framework-candidate',
    candidate.origin.source === 'framework-candidate',
    nativeFingerprint(candidate.origin.context) ===
      nativeFingerprint(fact.nativeEvidence!.origin.context),
  ].every(Boolean);
}
