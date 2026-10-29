import { z } from 'zod';
import type {
  DeclarationLoadingPlan,
  DeclarationRequestReceipt,
} from '../../domain/analysis/declaration-governance';
import { nativeCoverageIndexSchema } from '../analysis-cache/native-proof-schema';
const text = z.string();
export const declarationRequestSchema: z.ZodType<DeclarationRequestReceipt> =
  z.object({
    file: text,
    position: z.number(),
    channel: text,
    specifier: text,
    mode: text.nullable(),
    target: text.nullable(),
    resolutionState: z.enum([
      'resolved',
      'unresolved',
      'ambient',
      'suppressed',
      'unavailable',
    ]),
    redirects: z.array(text),
    environment: z.record(text, z.unknown()),
    externalLibrary: z.boolean().nullable(),
  });
export const declarationLoadingSchema: z.ZodType<DeclarationLoadingPlan> =
  z.object({
    version: z.literal(1),
    sourceConfig: text,
    purpose: z.enum(['graph', 'candidate-validation', 'type-provider']),
    coverage: nativeCoverageIndexSchema,
  });
