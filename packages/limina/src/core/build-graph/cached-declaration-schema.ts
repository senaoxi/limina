import { z } from 'zod';
import type { DeclarationContextDecision } from '../../domain/analysis/declaration-context';
import type { DeclarationCompilationEvidence } from '../../domain/analysis/declaration-governance';
import {
  nativeCoverageSchema,
  nativeFileIdentitySchema,
} from '../analysis-cache/native-proof-schema';
import { declarationRequestSchema } from '../declaration-governance/schema';
import { text } from './cached-data-schema';
import type { DependencyAnalysisResult } from './types';

const texts = z.array(text);
const declarationObservation = z.object({
  kind: z.enum(['consumption', 'root-input']),
  contextId: text,
  consumerConfig: text,
  file: nativeFileIdentitySchema,
  requestIds: texts,
});
const authority = z.object({
  checker: text,
  adapter: text,
  toolchain: text,
  executionEntry: text,
});
export const declarationEvidenceSchema: z.ZodType<DeclarationCompilationEvidence> =
  z.object({
    version: z.literal(5),
    authority,
    sourceConfig: text,
    contextId: text,
    purpose: z.enum(['graph', 'candidate-validation', 'type-provider']),
    coverageVersion: text,
    requestOrigins: z.array(
      z.object({ id: text, file: text, specifier: text }),
    ),
    completeness: z.enum(['complete', 'incomplete']),
    declarations: z.array(declarationObservation),
  });
const selection = z.union([
  z.object({ state: z.literal('local'), config: text }),
  z.object({
    state: z.literal('selected'),
    config: text,
    basis: z.enum(['unique-coverage', 'explicit-selection']),
  }),
  z.object({
    state: z.enum(['awaiting-selection', 'unavailable']),
    reason: text,
  }),
]);
export const declarationContextSchema: z.ZodType<DeclarationContextDecision> =
  z.object({
    kind: z.enum(['consumption', 'root-input']),
    consumerConfig: text,
    contextId: text,
    file: nativeFileIdentitySchema,
    requestIds: texts,
    coverage: nativeCoverageSchema,
    selection,
  });
const mapping = z.object({
  file: text,
  sourceConfig: text,
  referenceConfig: text,
  loaded: z.boolean(),
});
const referenceMapping = z.object({
  file: text,
  referenceConfig: text.nullable(),
  declarationOutput: text.nullable(),
  qualified: z.boolean(),
});
const receipt = z.object({
  version: z.literal(3),
  authority,
  contextId: text,
  generatedConfig: text,
  sourceConfig: text,
  checker: text,
  compilerVersion: text,
  inputFingerprint: text,
  decisionsFingerprint: text,
  referenceMappings: z.array(referenceMapping),
  requests: z.array(declarationRequestSchema),
  mappings: z.array(mapping),
});
export const declarationValidationSchema: z.ZodType<
  NonNullable<DependencyAnalysisResult['declarationValidation']>
> = z.object({
  state: z.enum(['admitted', 'denied', 'unavailable']),
  diagnostics: texts,
  receipts: z.array(receipt),
});
