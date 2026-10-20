import { z } from 'zod';
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
import type { VueQueryKind, VueQueryResults } from './vue-contracts';
import { VUE_ANALYSIS_ADAPTER } from './vue-identity';
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
const fact = z.object({
  eligibility: requestEligibilitySchema.optional(),
  framework: z.literal('vue'),
  importRecord: occurrenceSchema,
  provenance: z.enum(['direct-source', 'strict-source-map']),
  resolutionMode: text,
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
const schemas = {
  'type-environment-entries': z.array(declarationEntrySchema),
  'support-inputs': z.array(
    z.object({ filePath: text, records: z.array(occurrenceSchema) }),
  ),
  'dependency-observation': z.object({
    coverage: z.literal('complete'),
    redirect: redirectSchema.optional(),
  }),
  evidence,
  preparation: z.object({
    kind: z.literal('supported'),
    directSourceRecords: z.array(occurrenceSchema),
    facts: z.array(fact),
    unmapped: z.array(
      z.object({ generatedFilePath: text, semanticSpecifier: text }),
    ),
  }),
  resolution: z.object({
    framework: z.literal('vue'),
    profile: z
      .enum(['vue-sfc', 'petite-vue-html', 'vitepress-markdown'])
      .optional(),
    provenance: z.enum(['direct-source', 'strict-source-map']),
    resolutionMode: text,
    semanticSpecifier: text,
    sourceRecord: occurrenceSchema,
    target: target.nullable(),
  }),
};

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
  try {
    return parseVueQuery(kind, decodeData(data));
  } catch {
    return undefined;
  }
}

const querySchema = z.object({
  kind: z.enum([
    'preparation',
    'resolution',
    'evidence',
    'dependency-observation',
    'support-inputs',
    'type-environment-entries',
  ]),
  data: z.json(),
});
const outputProjection = z.object({
  sourceConfigPath: text,
  options: z.record(text, z.json()),
  fileNames: texts,
});
export const vueContextSchema: z.ZodType<unknown> = z.object({
  adapter: z.literal(VUE_ANALYSIS_ADAPTER),
  project: z.object({
    configPath: text,
    projectRootDir: text,
    extensions: texts,
    outputProjection: outputProjection.optional(),
  }),
  identity: z.json(),
  dependencies: z.array(dependencySchema),
  environment: typeEnvironmentSchema,
  members: texts,
  generated: z.record(text, text),
  queryIds: texts,
  queries: z.record(text, querySchema),
  complete: z.boolean(),
});
