import { z } from 'zod';
import type { AuthorityRecord } from './contracts';

const text = z.string();
const semanticChecker = z.enum([
  'tsc',
  'tsgo',
  'vue-tsc',
  'astro',
  'svelte-check',
]);
const frozenAuthority = z.object({
  kind: z.literal('locked'),
  family: z.enum(['typescript', 'vue', 'astro', 'svelte']),
  source: z.enum(['explicit', 'config', 'baseline']),
});
const seedEvidence = z.object({
  checker: semanticChecker,
  configPath: text,
  detail: text,
  source: z.enum(['explicit', 'config']),
});
const seedOwner = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pending') }),
  z.object({ kind: z.literal('resolved'), checker: semanticChecker }),
]);
const authoritySeedSchema = z.strictObject({
  configPath: text,
  kind: z.literal('type'),
  authoritativeOwner: semanticChecker.optional(),
  evidence: z.array(seedEvidence),
  localOwner: seedOwner,
  semanticAuthority: frozenAuthority,
  frozenSemanticAuthority: frozenAuthority,
});

export const authorityRecordSchema: z.ZodType<AuthorityRecord> = z.object({
  policy: z.number().int().positive(),
  projection: text,
  closure: z.array(text).nonempty(),
  seed: authoritySeedSchema,
  ambiguousCheckers: z.array(semanticChecker),
  fingerprint: text,
});
