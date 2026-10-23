import { z } from 'zod';
import {
  type ConfigValidationContext,
  validateGovernanceShape,
} from './shared';

const referenceEntry = z.strictObject({ path: z.string(), reason: z.string() });
const dependencyEntry = z.strictObject({
  name: z.string(),
  reason: z.string(),
});
const graphRule = z.strictObject({
  allow: z
    .strictObject({ refs: z.array(referenceEntry).optional() })
    .optional(),
  deny: z
    .strictObject({
      deps: z.array(dependencyEntry).optional(),
      refs: z.array(referenceEntry).optional(),
    })
    .optional(),
});

const graphShape = z.strictObject({ rules: z.record(z.string(), graphRule) });
const proofEntry = z.strictObject({ file: z.string(), reason: z.string() });
const proofShape = z.strictObject({ allowlist: z.array(proofEntry) });

export function validateGraphConfig(
  value: unknown,
  context: ConfigValidationContext,
): void {
  validateGovernanceShape({
    value,
    context,
    path: ['graph'],
    schema: graphShape,
  });
}

export function validateProofConfig(
  value: unknown,
  context: ConfigValidationContext,
): void {
  validateGovernanceShape({
    value,
    context,
    path: ['proof'],
    schema: proofShape,
  });
}
