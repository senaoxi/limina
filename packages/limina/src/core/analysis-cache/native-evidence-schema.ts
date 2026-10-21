import { z } from 'zod';
import {
  nativeCollectionStatus,
  type NativeCollectionStatus,
} from '../../domain/analysis/native-collection';
import type { NativeEvidenceSnapshot } from '../../domain/analysis/native-evidence';
import { NATIVE_EVIDENCE_VERSION } from '../../domain/analysis/native-evidence';
import { freezeNativeData } from '../../domain/analysis/native-evidence-freeze';
import { projectNativeReferences } from '../../domain/analysis/native-reference-projection';
import type { NativeAnalysisEvidence } from '../build-graph/native-analysis-evidence';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import { nativeObligationSchema } from './native-obligation-schema';
import {
  nativeContextProofSchema,
  nativeCoverageIndexSchema,
  nativeCoverageSchema,
  nativeFileIdentitySchema,
  nativeOriginSchema,
} from './native-proof-schema';

const text = z.string();
const texts = z.array(text);
const channel = z.enum([
  'module',
  'type-directive',
  'path-directive',
  'library',
  'ambient',
  'implicit',
]);
const entry = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('source'),
    file: nativeFileIdentitySchema,
    position: z.number(),
  }),
  z.object({ kind: z.literal('config'), configId: text, field: text }),
  z.object({ kind: z.literal('compiler'), reason: text }),
]);
const request = z.object({
  id: text,
  consumerContextId: text,
  origin: nativeOriginSchema,
  channel,
  sourceFile: nativeFileIdentitySchema.nullable(),
  entry,
  specifier: text,
  resolutionMode: text.nullable(),
  predecessorId: text.nullable(),
});
const pathCandidate = z.object({
  lexicalPath: text,
  physicalPath: text,
  present: z.boolean(),
});
const pathSelection = z.object({
  state: z.enum(['selected', 'missing', 'disabled', 'unavailable']),
  lexicalPath: text,
  logicalTarget: text.nullable(),
  candidates: z.array(pathCandidate),
  rule: text,
  reason: text.optional(),
});
const resolution = z.object({
  pathSelection: pathSelection.optional(),
  requestId: text,
  state: z.enum(['resolved', 'unresolved', 'ambient', 'unavailable']),
  target: nativeFileIdentitySchema.nullable(),
  rawRedirectEvidenceIds: texts,
  externalLibrary: z.boolean().nullable(),
  compilerLoad: z.enum(['loaded', 'attempted', 'not-observed', 'unknown']),
  evidenceIds: texts,
});
const relation = z.union([
  z.object({
    kind: z.literal('resolved-project-use'),
    consumerContextId: text,
    targetConfigId: text,
    coverageEvidenceId: text,
    requestIds: texts,
  }),
  z.object({
    kind: z.literal('compiler-reference-obligation'),
    obligationId: text,
  }),
  z.object({
    kind: z.literal('declaration-consumption'),
    consumerContextId: text,
    file: nativeFileIdentitySchema,
    requestIds: texts,
  }),
  z.object({
    kind: z.enum(['explicit-reference', 'framework-schedule', 'runtime-use']),
    consumerContextId: text,
    targetConfigId: text.nullable(),
    evidenceIds: texts,
  }),
]);
const scope = { contextId: text, entryId: text, channel, evidenceIds: texts };
const partition = z.union([
  z.object({ ...scope, state: z.enum(['observed', 'restored']) }),
  z.object({
    ...scope,
    state: z.literal('proven-stop'),
    stopReason: z.enum([
      'uncovered',
      'coverage-unavailable',
      'ambiguous-implementation',
      'foreign-implementation',
      'same-owner-non-root',
      'unresolved',
      'observation-unavailable',
      'resolution-disabled',
    ]),
  }),
  z.object({
    ...scope,
    state: z.literal('gap'),
    failureId: text,
    cause: z.enum([
      'unavailable',
      'input-drift',
      'unsupported',
      'internal-failure',
    ]),
  }),
]);
const affected = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('universe'), universeId: text }),
  z.object({ kind: z.literal('contexts'), contextIds: texts }),
  z.object({ kind: z.literal('entries'), contextId: text, entryIds: texts }),
]);
const failure = z.object({
  id: text,
  detail: text,
  kind: z.enum([
    'config-parse',
    'file-read',
    'compiler-initialization',
    'identity',
    'unsupported',
    'input-drift',
    'internal',
  ]),
  evidenceIds: texts,
  affected,
});
export const nativeEvidenceSchema: z.ZodType<NativeEvidenceSnapshot> = z.object(
  {
    version: z.literal(NATIVE_EVIDENCE_VERSION),
    run: z.enum(['completed', 'unavailable', 'interrupted', 'failed']),
    contexts: z.array(nativeContextProofSchema),
    coverageIndexes: z.array(nativeCoverageIndexSchema),
    coverage: z.array(nativeCoverageSchema),
    requests: z.array(request),
    traversal: z.array(
      z.object({
        requestId: text,
        parentRequestIds: texts,
        rootFileNames: texts,
      }),
    ),
    resolutions: z.array(resolution),
    relations: z.array(relation),
    obligations: z.array(nativeObligationSchema),
    completeness: z.array(partition),
    failures: z.array(failure),
  },
);

export const nativeCollectionStatusSchema: z.ZodType<NativeCollectionStatus> =
  z.object({
    execution: z.enum(['completed', 'partial', 'failed']),
    traversal: z.enum(['complete-within-boundary', 'incomplete']),
    compilationRelations: z.enum(['determined', 'undetermined']),
    failureIds: texts,
    undeterminedObligationIds: texts,
    relationBoundaryIds: texts,
  });
const projectedRelation = z.object({
  obligation: nativeObligationSchema,
  summary: z.enum(['required', 'already-satisfied', 'not-required', 'unknown']),
});
const referenceProjection = z.object({
  observedRelations: z.array(relation),
  relations: z.array(projectedRelation),
  completeness: z.enum(['determined', 'undetermined']),
  unresolvedObligationIds: texts,
  collectionFailureIds: texts,
  relationBoundaryIds: texts,
});
export const nativeAnalysisEvidenceSchema: z.ZodType<NativeAnalysisEvidence> = z
  .object({
    snapshot: nativeEvidenceSchema,
    collection: nativeCollectionStatusSchema,
    referenceProjection,
  })
  .refine(hasConsistentNativeAssessment)
  .transform(freezeNativeData);

function hasConsistentNativeAssessment(value: NativeAnalysisEvidence): boolean {
  return [
    nativeFingerprint(value.collection) ===
      nativeFingerprint(nativeCollectionStatus(value.snapshot)),
    nativeFingerprint(value.referenceProjection) ===
      nativeFingerprint(projectNativeReferences(value.snapshot)),
  ].every(Boolean);
}
