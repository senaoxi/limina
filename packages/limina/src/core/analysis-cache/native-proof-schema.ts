import { z } from 'zod';
import type {
  NativeEvidenceContext,
  NativeEvidenceOrigin,
} from '../../domain/analysis/native-context';
import type {
  NativeCoverage,
  NativeFileIdentity,
  SourceConfigCoverageIndex,
} from '../../domain/analysis/native-coverage';

const text = z.string();
const texts = z.array(text);
const authority = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('pending'), baseline: z.literal('typescript') }),
  z.object({
    phase: z.literal('locked'),
    family: z.enum(['typescript', 'vue', 'astro', 'svelte']),
    selectionEvidenceIds: texts,
  }),
]);
export const nativeContextProofSchema: z.ZodType<NativeEvidenceContext> =
  z.object({
    id: text,
    epoch: text,
    collectionId: text,
    inputs: z.object({
      typescriptVersion: text,
      typescriptImplementation: text,
      toolchain: text,
      hostContract: text,
      config: text,
      sourceConfig: text.optional(),
      roots: text,
      options: text,
      rawReferences: text,
      coverage: text,
      sourceVersion: text,
      compilationScope: text,
    }),
    authority,
  });
export const nativeOriginSchema: z.ZodType<NativeEvidenceOrigin> = z.union([
  z.object({
    context: nativeContextProofSchema,
    source: z.literal('typescript-observation'),
    family: z.literal('typescript'),
  }),
  z.object({
    context: nativeContextProofSchema,
    source: z.enum(['framework-candidate', 'framework-semantic']),
    family: z.enum(['vue', 'astro', 'svelte']),
  }),
]);
const physical = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('verified'),
    canonicalId: text,
    evidenceId: text,
    inputVersion: text,
  }),
  z.object({ state: z.literal('unavailable'), reason: text }),
]);
export const nativeFileIdentitySchema: z.ZodType<NativeFileIdentity> = z.object(
  {
    lexicalPath: text,
    physical,
  },
);
const impact = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unbounded') }),
  z.object({
    kind: z.literal('proven-exclusion'),
    evidenceId: text,
    excludedCanonicalIds: texts,
  }),
]);
const enumeration = z.discriminatedUnion('state', [
  z.object({
    configId: text,
    inputVersion: text,
    state: z.literal('enumerated'),
    evidenceId: text,
    complete: z.boolean(),
    members: z.array(nativeFileIdentitySchema),
  }),
  z.object({
    configId: text,
    inputVersion: text,
    state: z.literal('failed'),
    failureId: text,
    impact,
  }),
]);
export const nativeCoverageIndexSchema: z.ZodType<SourceConfigCoverageIndex> =
  z.object({
    inputVersion: text,
    universe: z.object({
      id: text,
      revision: text,
      inputVersion: text,
      selectionEvidenceId: text,
      scopeFingerprint: text,
      sourceConfigIds: texts,
      discovery: z.enum(['closed', 'open']),
    }),
    configurations: z.array(enumeration),
  });
const member = z.object({
  configId: text,
  membershipEvidenceId: text,
  match: z.enum(['lexical', 'canonical']),
});
export const nativeCoverageSchema: z.ZodType<NativeCoverage> = z.object({
  universeId: text,
  indexRevision: text,
  inputVersion: text,
  target: nativeFileIdentitySchema,
  members: z.array(member),
  completeness: z.enum(['complete', 'incomplete']),
  gaps: texts,
  state: z.enum(['uncovered', 'unavailable', 'unique', 'ambiguous']),
});
