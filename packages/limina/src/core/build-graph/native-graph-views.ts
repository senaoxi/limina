import { z } from 'zod';
import { nativeCollectionStatus } from '../../domain/analysis/native-collection';
import {
  NATIVE_EVIDENCE_VERSION,
  type NativeEvidenceSnapshot,
} from '../../domain/analysis/native-evidence';
import { freezeNativeData } from '../../domain/analysis/native-evidence-freeze';
import { projectNativeReferences } from '../../domain/analysis/native-reference-projection';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import type { StoredGraphData } from './analysis-cache-schema';
import type { CheckerDependencyFact } from './checker-ownership-types';

const fields = [
  'contexts',
  'coverageIndexes',
  'coverage',
  'requests',
  'traversal',
  'resolutions',
  'relations',
  'obligations',
  'completeness',
  'failures',
] as const;
type Field = (typeof fields)[number];
const reference = z.strictObject({
  context: z.string(),
  index: z.number().int().nonnegative(),
});
type Reference = z.infer<typeof reference>;
const references = z.array(reference);
const snapshotView = z.object({
  version: z.literal(NATIVE_EVIDENCE_VERSION),
  run: z.enum(['completed', 'unavailable', 'interrupted', 'failed']),
  contexts: references,
  coverageIndexes: references,
  coverage: references,
  requests: references,
  traversal: references,
  resolutions: references,
  relations: references,
  obligations: references,
  completeness: references,
  failures: references,
});
const factReference = z.strictObject({
  context: z.string(),
  importer: z.string(),
  occurrence: z.string(),
});
type FactReference = z.infer<typeof factReference>;
const factView = z.looseObject({ nativeEvidence: factReference.optional() });
const dependencyView = z.looseObject({
  nativeEvidence: z.array(snapshotView),
});
const ownershipView = z.looseObject({
  dependencyFacts: z.array(factView),
  ownershipSelectionFacts: z.array(factView).optional(),
});
const projectionView = z.looseObject({
  sourceConfigCoverage: reference.optional(),
  dependencyAnalysis: dependencyView,
  ownershipPlan: ownershipView,
});
const view = z.object({
  format: z.literal('native-context-views-v1'),
  projection: projectionView,
});

/**
Graphs retain ordered views. Context facts and compiler inventories own proof.
*/
class NativeGraphReferences {
  readonly #records = new Map<string, Reference>();
  readonly #facts = new Map<string, FactReference>();
  constructor(cache: NativeAnalysisCache) {
    for (const [id, context] of Object.entries(cache.contexts)) {
      if (context.native === undefined) continue;
      for (const field of fields) {
        const entries = context.native.snapshot[field].entries();
        for (const [index, value] of entries) {
          this.#records.set(this.#key(field, value), { context: id, index });
        }
      }
    }
    for (const [id, importer] of Object.entries(cache.importers))
      for (const [occurrence, fact] of Object.entries(importer.facts))
        if (fact.nativeEvidence !== undefined)
          this.#facts.set(fact.nativeEvidence.requestId, {
            context: importer.contextId,
            importer: id,
            occurrence,
          });
  }
  #key(field: Field, value: unknown): string {
    return `${field}:${nativeFingerprint(value)}`;
  }
  record(field: Field, value: unknown): Reference {
    const reference = this.#records.get(this.#key(field, value));
    if (reference === undefined)
      throw new Error('Graph fact lacks a context owner.');
    return reference;
  }
  snapshot(snapshot: NativeEvidenceSnapshot): unknown {
    return {
      version: snapshot.version,
      run: snapshot.run,
      ...Object.fromEntries(
        fields.map((field) => [
          field,
          snapshot[field].map((value) => this.record(field, value)),
        ]),
      ),
    };
  }
  fact(fact: CheckerDependencyFact): unknown {
    if (fact.nativeEvidence === undefined) return fact;
    const reference = this.#facts.get(fact.nativeEvidence.requestId);
    if (reference === undefined)
      throw new Error('Graph occurrence lacks a context owner.');
    return { ...fact, nativeEvidence: reference };
  }
}

export function storeNativeGraphViews(
  graph: StoredGraphData,
  cache: NativeAnalysisCache,
): unknown {
  const references = new NativeGraphReferences(cache);
  return {
    format: 'native-context-views-v1',
    projection: {
      ...graph,
      sourceConfigCoverage:
        graph.sourceConfigCoverage === undefined
          ? undefined
          : references.record('coverageIndexes', graph.sourceConfigCoverage),
      dependencyAnalysis: {
        ...graph.dependencyAnalysis,
        nativeEvidence: (graph.dependencyAnalysis.nativeEvidence ?? []).map(
          (entry) => references.snapshot(entry.snapshot),
        ),
      },
      ownershipPlan: {
        ...graph.ownershipPlan,
        dependencyFacts: graph.ownershipPlan.dependencyFacts.map((fact) =>
          references.fact(fact),
        ),
        ownershipSelectionFacts:
          graph.ownershipPlan.ownershipSelectionFacts?.map((fact) =>
            references.fact(fact),
          ),
      },
    },
  };
}

function readReference(
  cache: NativeAnalysisCache,
  field: Field,
  reference: Reference,
): unknown {
  const snapshot = cache.contexts[reference.context]?.native?.snapshot;
  const value = snapshot?.[field][reference.index];
  if (value === undefined)
    throw new Error('Graph context fact is unavailable.');
  return value;
}
function readSnapshot(
  cache: NativeAnalysisCache,
  view: z.infer<typeof snapshotView>,
): NativeEvidenceSnapshot {
  return freezeNativeData({
    version: view.version,
    run: view.run,
    ...Object.fromEntries(
      fields.map((field) => [
        field,
        view[field].map((reference) => readReference(cache, field, reference)),
      ]),
    ),
  }) as NativeEvidenceSnapshot;
}
function readFact(
  cache: NativeAnalysisCache,
  fact: z.infer<typeof factView>,
): unknown {
  const reference = fact.nativeEvidence;
  if (reference === undefined) return fact;
  const importer = cache.importers[reference.importer];
  const evidence = importer?.facts[reference.occurrence]?.nativeEvidence;
  if (evidence === undefined || importer.contextId !== reference.context)
    throw new Error('Graph occurrence reference is unavailable.');
  return { ...fact, nativeEvidence: evidence };
}
export function restoreNativeGraphViews(
  value: unknown,
  cache: NativeAnalysisCache,
): unknown {
  const { projection } = view.parse(value);
  return {
    ...projection,
    sourceConfigCoverage:
      projection.sourceConfigCoverage === undefined
        ? undefined
        : readReference(
            cache,
            'coverageIndexes',
            projection.sourceConfigCoverage,
          ),
    dependencyAnalysis: {
      ...projection.dependencyAnalysis,
      nativeEvidence: projection.dependencyAnalysis.nativeEvidence.map(
        (entry) => {
          const snapshot = readSnapshot(cache, entry);
          return {
            snapshot,
            collection: nativeCollectionStatus(snapshot),
            referenceProjection: projectNativeReferences(snapshot),
          };
        },
      ),
    },
    ownershipPlan: {
      ...projection.ownershipPlan,
      dependencyFacts: projection.ownershipPlan.dependencyFacts.map((fact) =>
        readFact(cache, fact),
      ),
      ownershipSelectionFacts:
        projection.ownershipPlan.ownershipSelectionFacts?.map((fact) =>
          readFact(cache, fact),
        ),
    },
  };
}
