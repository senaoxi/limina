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
import { immutableNativeSchema } from './immutable-schema';

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
const nativeContextProofSchemaShape = z.object({
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
export const nativeContextProofSchema: z.ZodType<NativeEvidenceContext> =
  immutableNativeSchema(nativeContextProofSchemaShape);
const nativeOriginSchemaShape = z.union([
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
export const nativeOriginSchema: z.ZodType<NativeEvidenceOrigin> =
  immutableNativeSchema(nativeOriginSchemaShape);
const physical = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('verified'),
    canonicalId: text,
    evidenceId: text,
    inputVersion: text,
  }),
  z.object({ state: z.literal('unavailable'), reason: text }),
]);
const nativeFileIdentitySchemaShape = z.object({
  lexicalPath: text,
  physical,
});
export const nativeFileIdentitySchema: z.ZodType<NativeFileIdentity> =
  immutableNativeSchema(nativeFileIdentitySchemaShape);
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
const nativeCoverageIndexSchemaShape = z.object({
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
export const nativeCoverageIndexSchema: z.ZodType<SourceConfigCoverageIndex> =
  immutableNativeSchema(nativeCoverageIndexSchemaShape);
const member = z.object({
  configId: text,
  membershipEvidenceId: text,
  match: z.enum(['lexical', 'canonical']),
});
const nativeCoverageSchemaShape = z.object({
  universeId: text,
  indexRevision: text,
  inputVersion: text,
  target: nativeFileIdentitySchema,
  members: z.array(member),
  completeness: z.enum(['complete', 'incomplete']),
  gaps: texts,
  state: z.enum(['uncovered', 'unavailable', 'unique', 'ambiguous']),
});
export const nativeCoverageSchema: z.ZodType<NativeCoverage> =
  immutableNativeSchema(nativeCoverageSchemaShape);
