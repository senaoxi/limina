import { z } from 'zod';
import { declarationRequestSchema } from '../declaration-governance/schema';
import { decodeData } from './data-codec';
import {
  declarationEntrySchema,
  hasDeclarationReceipt,
  requestEligibilitySchema,
  resolutionOriginSchema,
} from './declaration-schema';
import { dependencySchema } from './dependency-schema';
import { typeEnvironmentSchema } from './environment-schema';
import { occurrenceSchema } from './occurrence-schema';
import { isDecodedRecord } from './record-table';
import type { VueQueryKind, VueQueryResults } from './vue-contracts';
import { VUE_ANALYSIS_ADAPTER } from './vue-identity';
import { vueModuleResultSchema } from './vue-module-result';
const redirectSchema = z.object({
  originalTarget: z.string(),
  declarationTarget: z.string(),
  referenceConfig: z.string(),
  availability: z.enum(['present', 'missing']),
});

const text = z.string();
const texts = z.array(text);
const target = z
  .object({
    resolutionOrigin: resolutionOriginSchema.optional(),
    resolvedFileName: text,
    resolvedBy: z.enum(['typescript', 'checker-source']),
    isExternalLibraryImport: z.boolean(),
  })
  .refine(hasDeclarationReceipt);
const managedSource = z
  .object({
    checkerNames: texts,
    declarationFilePath: text,
    mappedSourceFilePath: text,
    reason: z.literal('owned-source'),
    sourceConfigPath: text,
  })
  .optional();
const evidence = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('missing') }),
  z.object({
    kind: z.literal('ambient'),
    declarationFilePaths: texts,
    modulePattern: text,
  }),
  z.object({ kind: z.literal('checker-source'), filePath: text }),
  z.object({
    kind: z.literal('concrete-declaration'),
    filePath: text,
    managedSource,
  }),
]);
const compilerRequest = z.object({
  fileName: text,
  start: z.number(),
  end: z.number(),
  specifier: text,
  mode: z.number().optional(),
  role: z.enum(['import', 'augmentation', 'path-directive', 'type-directive']),
  target: text.nullable(),
});
const compilationObligation = z.object({
  state: z.enum(['present', 'absent', 'unknown']),
  contextConfig: text,
  reason: text,
  requests: z.array(compilerRequest),
});
const compilerFact = z.object({
  compilationObligation,
  eligibility: requestEligibilitySchema.optional(),
  framework: z.literal('vue'),
  importRecord: occurrenceSchema,
  provenance: z.enum([
    'direct-source',
    'strict-source-map',
    'compiler-request',
  ]),
  resolutionMode: text,
  runtimeOnly: z.never().optional(),
  semanticSpecifier: text,
  target: target.nullable(),
  redirect: redirectSchema.optional(),
  typeEvidence: evidence.optional(),
  typeEvidenceOrigin: z
    .object({
      contextIdentity: text,
      fileName: text,
      start: z.number(),
      end: z.number(),
    })
    .optional(),
  compilerMembership: z
    .enum(['covered', 'not-covered', 'unobserved'])
    .optional(),
});
const runtimeOccurrence = z.object({
  compilerRequest: z.never().optional(),
  configurationSource: z.never().optional(),
  kind: z.enum(['commonjs', 'require-resolve', 'jsdoc-import']),
});
const runtimeFact = z.strictObject({
  compilationObligation: z.never().optional(),
  framework: z.literal('vue'),
  importRecord: occurrenceSchema.and(runtimeOccurrence),
  provenance: z.literal('strict-source-map'),
  resolutionMode: z.enum(['default', 'import', 'require']),
  runtimeOnly: z.literal(true),
  semanticSpecifier: text,
  target: target.nullable(),
  typeEvidence: z.never().optional(),
  typeEvidenceOrigin: z.never().optional(),
});
const preparation = z.object({
  kind: z.literal('supported'),
  directSourceRecords: z.array(occurrenceSchema),
  facts: z.array(compilerFact),
  unmapped: z.array(
    z.object({ generatedFilePath: text, semanticSpecifier: text }),
  ),
});
const schemas = {
  'request-inventory': z.object({
    complete: z.boolean(),
    requests: z.array(declarationRequestSchema),
  }),
  'compiler-source': z.array(occurrenceSchema),
  'type-environment-entries': z.array(declarationEntrySchema),
  'support-inputs': z.array(
    z.object({ filePath: text, records: z.array(occurrenceSchema) }),
  ),
  'dependency-observation': z.object({
    coverage: z.literal('complete'),
    compilationObligation,
    redirect: redirectSchema.optional(),
  }),
  evidence,
  preparation,
  'runtime-preparation': preparation.extend({
    facts: z.array(z.union([compilerFact, runtimeFact])),
  }),
  resolution: z.object({
    framework: z.literal('vue'),
    profile: z
      .enum(['vue-sfc', 'petite-vue-html', 'vitepress-markdown'])
      .optional(),
    provenance: z.enum([
      'direct-source',
      'strict-source-map',
      'compiler-request',
    ]),
    resolutionMode: text,
    semanticSpecifier: text,
    sourceRecord: occurrenceSchema,
    target: target.nullable(),
  }),
};
const decoded = new WeakMap<object, Map<VueQueryKind, unknown>>();

export function parseVueQuery<K extends VueQueryKind>(
  kind: K,
  data: unknown,
): VueQueryResults[K] | undefined {
  const parsed = schemas[kind].safeParse(data);
  return parsed.success ? (parsed.data as VueQueryResults[K]) : undefined;
}

export function decodeVueQuery<K extends VueQueryKind>(
  kind: K,
  data: unknown,
): VueQueryResults[K] | undefined {
  const value = qualifiedVueQuery(kind, data);
  freezeQueryResult(value);
  return value;
}

function freezeQueryResult(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value))
    return;
  for (const child of Object.values(value)) freezeQueryResult(child);
  Object.freeze(value);
}

function qualifiedVueQuery<K extends VueQueryKind>(
  kind: K,
  data: unknown,
): VueQueryResults[K] | undefined {
  const isPrivateData = isDecodedRecord(data);
  const prior = isPrivateData ? decoded.get(data) : undefined;
  if (prior?.has(kind)) return prior.get(kind) as VueQueryResults[K];
  try {
    const result = parseVueQuery(kind, decodeData(data, isPrivateData));
    if (isPrivateData && result !== undefined) {
      const entries = prior ?? new Map<VueQueryKind, unknown>();
      entries.set(kind, result);
      decoded.set(data, entries);
    }
    return result;
  } catch {
    return undefined;
  }
}

export function hasValidVueQuery(kind: VueQueryKind, data: unknown): boolean {
  return qualifiedVueQuery(kind, data) !== undefined;
}

const querySchema = z.object({
  kind: z.enum([
    'request-inventory',
    'compiler-source',
    'preparation',
    'runtime-preparation',
    'resolution',
    'evidence',
    'dependency-observation',
    'support-inputs',
    'type-environment-entries',
  ]),
  data: z.unknown(),
});
const moduleResolutionSchema = z.object({
  members: texts,
  dependencies: z.array(dependencySchema),
  result: vueModuleResultSchema,
  targetOwners: texts.nullable(),
});
export const vueContextSchema: z.ZodType<unknown> = z.object({
  adapter: z.literal(VUE_ANALYSIS_ADAPTER),
  project: z.strictObject({
    configPath: text,
    sourceConfigPath: text.optional(),
  }),
  identity: z.json(),
  dependencies: z.array(dependencySchema),
  environment: typeEnvironmentSchema,
  members: texts,
  generated: z.record(text, text),
  queryIds: texts,
  queries: z.record(text, querySchema),
  moduleResolutions: z.record(text, moduleResolutionSchema),
  moduleContextId: text,
  complete: z.boolean(),
});
