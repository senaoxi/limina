import { z } from 'zod';
import { configModuleSnapshotSchema } from './config-module-schema';
import { ANALYSIS_ADAPTER, type AnalysisSnapshot } from './contracts';
import {
  hasDeclarationReceipt,
  requestEligibilitySchema,
  resolutionOriginSchema,
} from './declaration-schema';
import { dependencySchema as dependency } from './dependency-schema';
import { discoveryRecordSchema } from './discovery-schema';
import { nativeContextSchema } from './environment-schema';
import { occurrenceSchema } from './occurrence-schema';
import { validatedSnapshot } from './snapshot-validation';
import { vueContextSchema } from './vue-schema';

const text = z.string();
const texts = z.array(text);
const optionalNumber = z.number().optional();
const target = z
  .object({
    resolutionOrigin: resolutionOriginSchema.optional(),
    resolvedFileName: text,
    resolvedBy: z.literal('typescript'),
    isExternalLibraryImport: z.boolean(),
  })
  .refine(hasDeclarationReceipt);
const typeEvidence = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('missing') }),
  z.object({
    kind: z.literal('ambient'),
    declarationFilePaths: texts,
    modulePattern: text,
  }),
  z.object({ kind: z.literal('concrete-declaration'), filePath: text }),
  z.object({ kind: z.literal('checker-source'), filePath: text }),
]);
const fact = z.object({
  eligibility: requestEligibilitySchema.optional(),
  admission: z.enum(['admitted', 'excluded', 'unresolved']),
  typeEvidence: typeEvidence.optional(),
  redirect: z
    .object({
      originalTarget: text,
      declarationTarget: text,
      referenceConfig: text,
      availability: z.enum(['present', 'missing']),
    })
    .optional(),
  referenceRequirement: z
    .object({
      kind: z.enum(['compiler-membership', 'source-semantic']),
      targetFileName: text,
    })
    .nullable(),
  resolution: z.object({
    channel: z.enum([
      'module',
      'jsx-runtime',
      'environment-pragma',
      'lib-environment',
      'triple-slash-path',
      'triple-slash-types',
    ]),
    identity: text,
    redirectedReferenceIdentity: text.nullable(),
    resolutionMode: optionalNumber,
    target: target.nullable(),
  }),
});
const rawTarget = z
  .looseObject({
    resolutionOrigin: resolutionOriginSchema.optional(),
    resolvedFileName: text,
    extension: text.optional(),
    isExternalLibraryImport: z.boolean().optional(),
    originalPath: text.optional(),
    primary: z.boolean().optional(),
    packageId: z
      .object({
        name: text,
        subModuleName: text,
        version: text,
        peerDependencies: text.optional(),
      })
      .optional(),
  })
  .catchall(z.json());
const rawResult = z
  .looseObject({
    resolvedModule: rawTarget.optional(),
    resolvedTypeReferenceDirective: rawTarget.optional(),
    failedLookupLocations: texts.optional(),
    affectingLocations: texts.optional(),
  })
  .catchall(z.json());
const coverage = z.enum(['complete', 'unknown']);
const inputsRecord = z.object({
  path: text,
  kind: z.enum([
    'content',
    'file',
    'directory',
    'directories',
    'entries',
    'realpath',
    'binding',
    'tree',
    'bytes',
    'imports',
    'exports',
  ]),
  version: text,
  observedMtime: optionalNumber,
  verifiedThrough: optionalNumber,
  text: text.optional(),
  installedTargets: z.array(text).optional(),
});
const queriesRecord = z.object({
  contextId: text,
  file: text,
  request: z.json(),
  result: rawResult,
  dependencies: z.array(dependency),
  coverage,
});
const importersRecord = z.object({
  contextId: text,
  filePath: text,
  sourceVersion: text,
  environmentVersion: text,
  membershipVersion: text,
  dependencies: z.array(dependency),
  queryIds: texts,
  occurrences: z.array(occurrenceSchema),
  facts: z.record(text, fact),
  coverage,
});
const projectsRecord = z.object({
  roots: texts,
  members: texts,
  environment: texts,
  references: z.json(),
});
const contributionsRecord = z.object({
  occurrence: occurrenceSchema,
  sourceVersion: text,
  fromChecker: text,
  toChecker: text,
  fromConfigPath: text,
  toConfigPath: text,
  kind: text,
});
const graphRecord = z.object({
  workspaceVersion: text,
  queryIds: texts,
  contextIds: texts,
  vueContextIds: texts,
  dependencies: z.array(dependency),
  data: z.json(),
  discovery: z.array(discoveryRecordSchema),
});
const header = z.object({
  schema: z.literal(8),
  implementation: z.literal(ANALYSIS_ADAPTER),
  identity: text,
  configVersion: text,
  revision: z.uuid(),
});
const requestTemplate = z.object({
  occurrence: occurrenceSchema,
  explicitMode: optionalNumber,
  governance: z.boolean(),
  expansion: z.boolean(),
  externalModuleOnly: z.boolean().optional(),
});
const fileFacts = z.object({
  version: z.literal(1),
  compilerVersion: text,
  filePath: text,
  sourceVersion: text,
  externalModule: z.boolean(),
  declaration: z.boolean(),
  containsJsx: z.boolean(),
  noDefaultLib: z.boolean(),
  jsxRuntime: text.optional(),
  requests: z.array(requestTemplate),
  libraries: texts,
});
const snapshot = z.object({
  header,
  configModules: configModuleSnapshotSchema,
  inputs: z.record(text, inputsRecord),
  queries: z.record(text, queriesRecord),
  importers: z.record(text, importersRecord),
  files: z.record(text, fileFacts),
  projects: z.record(text, projectsRecord),
  contributions: z.record(text, z.array(contributionsRecord)),
  graphs: z.record(text, graphRecord),
  contexts: z.record(text, nativeContextSchema),
  vueContexts: z.record(text, vueContextSchema),
});

export function parseAnalysisSnapshot(
  value: unknown,
  identity: string,
  configVersion?: string,
): AnalysisSnapshot | undefined {
  const root = parseAnalysisSnapshotRoot(value, identity);
  if (!isRestorableRoot(root, configVersion)) return undefined;
  const parsed = snapshot.safeParse(value);
  return parsed.success
    ? validatedSnapshot(parsed.data as unknown as AnalysisSnapshot)
    : undefined;
}
function isRestorableRoot(
  root: Pick<AnalysisSnapshot, 'header' | 'configModules'> | undefined,
  version: string | undefined,
): boolean {
  if (root === undefined) return false;
  return [
    root.configModules.complete,
    isMatchingConfigVersion(root.header.configVersion, version),
  ].every(Boolean);
}
function isMatchingConfigVersion(
  actual: string | null,
  expected: string | undefined,
): boolean {
  return expected === undefined || actual === expected;
}

export function parseAnalysisSnapshotRoot(
  value: unknown,
  identity: string,
): Pick<AnalysisSnapshot, 'header' | 'configModules'> | undefined {
  const parsed = z
    .object({ header, configModules: configModuleSnapshotSchema })
    .safeParse(value);
  return parsed.success && parsed.data.header.identity === identity
    ? parsed.data
    : undefined;
}
