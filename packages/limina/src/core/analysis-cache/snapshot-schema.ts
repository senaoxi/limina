import { z } from 'zod';
import { isPublishedNativeData } from '../../domain/analysis/native-evidence-freeze';
import { configModuleSnapshotSchema } from './config-module-schema';
import {
  ANALYSIS_ADAPTER,
  ANALYSIS_SCHEMA,
  type AnalysisSnapshot,
} from './contracts';
import {
  hasDeclarationReceipt,
  requestEligibilitySchema,
  resolutionOriginSchema,
} from './declaration-schema';
import { dependencySchema as dependency } from './dependency-schema';
import { discoveryRecordSchema } from './discovery-schema';
import { nativeContextSchema } from './environment-schema';
import { nativeFactEvidenceSchema } from './native-obligation-schema';
import { occurrenceSchema } from './occurrence-schema';
import { validatedSnapshot } from './snapshot-validation';
import { vueContextSchema } from './vue-schema';

const text = z.string();
const texts = z.array(text);
const optionalNumber = z.number().optional();
const target = z.object({
  resolutionOrigin: resolutionOriginSchema.optional(),
  resolvedFileName: text,
  resolvedBy: z.literal('typescript'),
  isExternalLibraryImport: z.boolean(),
});
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
const fact = z
  .object({
    nativeEvidence: nativeFactEvidenceSchema.optional(),
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
  })
  .refine((value) => hasFactResolutionReceipt(value));

function hasFactResolutionReceipt(value: {
  nativeEvidence?: unknown;
  resolution: { target: Parameters<typeof hasDeclarationReceipt>[0] | null };
}): boolean {
  return [
    value.nativeEvidence !== undefined,
    value.resolution.target === null,
    hasDeclarationReceiptForTarget(value.resolution.target),
  ].some(Boolean);
}
function hasDeclarationReceiptForTarget(
  target: Parameters<typeof hasDeclarationReceipt>[0] | null,
): boolean {
  return target !== null && hasDeclarationReceipt(target);
}
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
    'config-mtime',
    'affecting-mtime',
    'content',
    'file',
    'directory',
    'directories',
    'entries',
    'realpath',
    'binding',
    'manifest',
    'type-packages',
    'directory-identity',
    'tree',
    'bytes',
  ]),
  version: text,
  contentStamp: text.optional(),
  textVersions: z
    .object({ utf8: text, typescript: text.optional() })
    .optional(),
});
const queriesRecord = z.object({
  contextId: text,
  file: text,
  request: z.json(),
  targetOwners: texts.nullable().optional(),
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
const scopeManifest = z.object({
  directory: text,
  role: z.enum(['active', 'extended', 'boundary']),
  version: text,
});
const configScope = z.object({
  scope: text,
  role: z.enum(['source', 'solution']),
});
const packageScopes = z.object({
  manifests: z.record(text, scopeManifest),
  configs: z.record(text, configScope),
});
const header = z.object({
  schema: z.literal(ANALYSIS_SCHEMA),
  implementation: z.literal(ANALYSIS_ADAPTER),
  identity: text,
  configVersion: text,
  revision: z.uuid(),
  baselineTime: z.number().nonnegative().optional(),
  packageScopes,
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
  physicalVersion: text,
  externalModule: z.boolean(),
  declaration: z.boolean(),
  containsJsx: z.boolean(),
  noDefaultLib: z.boolean(),
  jsxRuntime: text.optional(),
  requests: z.array(requestTemplate),
  libraries: texts,
});
const sourceAuthority = z.strictObject({
  family: z.enum(['astro', 'svelte', 'typescript', 'vue']),
  source: z.enum(['explicit', 'config', 'baseline']),
  provider: text,
  toolchain: text,
});
const configProjection = z.strictObject({
  data: text,
  reads: z.array(discoveryRecordSchema).min(1),
  integrity: text,
});
const sourceConfig = z.strictObject({
  authority: sourceAuthority,
  projections: z.record(text, configProjection),
});
const snapshot = z.strictObject({
  header,
  configModules: configModuleSnapshotSchema,
  inputs: z.record(text, inputsRecord),
  queries: z.record(text, queriesRecord),
  importers: z.record(text, importersRecord),
  files: z.record(text, fileFacts),
  projects: z.record(text, projectsRecord),
  contexts: z.record(text, nativeContextSchema),
  vueContexts: z.record(text, vueContextSchema),
  sourceConfigs: z.record(text, sourceConfig),
});

const storedBindings = new WeakSet<AnalysisSnapshot>();

export function hasStoredNativeBindings(snapshot: AnalysisSnapshot): boolean {
  return storedBindings.has(snapshot);
}

export function parseStoredAnalysisSnapshot(
  value: unknown,
  identity: string,
  configVersion: string,
): AnalysisSnapshot | undefined {
  const parsed = parseAnalysisSnapshot(value, identity, configVersion);
  if (parsed === undefined) return undefined;
  freezeStoredBinding(parsed.contexts);
  freezeStoredBinding(parsed.projects);
  freezeStoredBinding(parsed.importers);
  freezeStoredBinding(parsed.queries);
  Object.freeze(parsed.header);
  Object.freeze(parsed);
  storedBindings.add(parsed);
  return parsed;
}

function freezeStoredBinding(value: unknown): void {
  if (
    value === null ||
    typeof value !== 'object' ||
    isPublishedNativeData(value)
  )
    return;
  for (const child of Object.values(value)) freezeStoredBinding(child);
  Object.freeze(value);
}

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

type SnapshotRoot = Pick<AnalysisSnapshot, 'header' | 'configModules'>;

export function qualifyAnalysisSnapshotRoot(
  value: unknown,
  identity: string,
):
  | { kind: 'qualified'; root: SnapshotRoot }
  | { kind: 'invalid-header' | 'incompatible-header' | 'identity-mismatch' } {
  const parsed = z
    .object({ header, configModules: configModuleSnapshotSchema })
    .safeParse(value);
  if (!parsed.success) {
    const isIncompatible = parsed.error.issues.some(
      ({ path }) =>
        path[0] === 'header' &&
        (path[1] === 'schema' || path[1] === 'implementation'),
    );
    return { kind: isIncompatible ? 'incompatible-header' : 'invalid-header' };
  }
  return parsed.data.header.identity === identity
    ? { kind: 'qualified', root: parsed.data }
    : { kind: 'identity-mismatch' };
}

export function parseAnalysisSnapshotRoot(
  value: unknown,
  identity: string,
): SnapshotRoot | undefined {
  const result = qualifyAnalysisSnapshotRoot(value, identity);
  return result.kind === 'qualified' ? result.root : undefined;
}
