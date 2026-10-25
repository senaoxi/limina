import { z } from 'zod';
import type { DeclarationContextDecision } from '../../domain/analysis/declaration-context';
import {
  nativeCoverageSchema,
  nativeFileIdentitySchema,
} from '../analysis-cache/native-proof-schema';
import { text } from './cached-data-schema';
import type { DependencyAnalysisResult } from './types';

const texts = z.array(text);
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
    consumerConfig: text,
    contextId: text,
    file: nativeFileIdentitySchema,
    requestIds: texts,
    coverage: nativeCoverageSchema,
    selection,
  });
const request = z.object({
  file: text,
  position: z.number(),
  channel: text,
  specifier: text,
  mode: text.nullable(),
  target: text.nullable(),
  resolutionState: z.enum(['ambient', 'resolved', 'unresolved', 'unavailable']),
  redirects: texts,
});
const mapping = z.object({
  file: text,
  sourceConfig: text,
  referenceConfig: text,
  loaded: z.boolean(),
});
const receipt = z.object({
  version: z.literal(2),
  contextId: text,
  generatedConfig: text,
  sourceConfig: text,
  checker: text,
  compilerVersion: text,
  inputFingerprint: text,
  decisionsFingerprint: text,
  requests: z.array(request),
  mappings: z.array(mapping),
});
export const declarationValidationSchema: z.ZodType<
  NonNullable<DependencyAnalysisResult['declarationValidation']>
> = z.object({
  state: z.enum(['admitted', 'denied', 'unavailable']),
  diagnostics: texts,
  receipts: z.array(receipt),
});
