import { z } from 'zod';
import type { NativeCompilationObligation } from '../../domain/analysis/native-obligation';
import type { NativeDependencyFact } from '../typescript-semantic/dependency-fact';
import {
  nativeCoverageSchema,
  nativeOriginSchema,
} from './native-proof-schema';

const text = z.string();
const texts = z.array(text);
const proof = z.object({
  kind: z.enum(['compiler-observation', 'audited-rule']),
  evidenceId: text,
  contextId: text,
  ruleOrObservation: text,
});
const unknown = z.object({
  state: z.enum(['unknown', 'not-applicable']),
  reason: text,
});
const existence = z.union([
  z.object({ state: z.enum(['present', 'absent']), proof }),
  z.object({ state: z.literal('unknown'), gapIds: texts }),
]);
const mapping = z.object({
  consumerConfigId: text,
  targetConfigId: text,
  redirectEvidenceIds: texts,
});
const structure = z.union([
  z.object({
    state: z.enum(['satisfied', 'unsatisfied']),
    evidenceId: text,
    contextId: text,
    rawReferenceFingerprint: text,
    mapping,
  }),
  unknown,
]);
const artifact = z.union([
  z.object({
    state: z.literal('available'),
    evidenceId: text,
    producerInputFingerprint: text,
    outputFingerprint: text,
    validatedMappingId: text,
  }),
  z.object({ state: z.enum(['missing', 'stale']), evidenceId: text }),
  unknown,
]);
export const nativeObligationSchema: z.ZodType<NativeCompilationObligation> =
  z.object({
    id: text,
    requestIds: texts,
    consumerContextId: text,
    consumerConfigId: text,
    rawReferenceFingerprint: text,
    targetConfigId: text.nullable(),
    existence,
    structure,
    artifact,
  });
export const nativeFactEvidenceSchema: z.ZodType<
  NonNullable<NativeDependencyFact['nativeEvidence']>
> = z.object({
  requestId: text,
  origin: nativeOriginSchema,
  coverage: nativeCoverageSchema.nullable(),
  obligation: nativeObligationSchema.nullable(),
});
