import { z } from 'zod';
import { authorityRecordSchema } from './authority-record-schema';
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
    'tree',
    'bytes',
  ]),
  version: text,
  contentStamp: text.optional(),
  textVersions: z
    .object({ utf8: text, typescript: text.optional() })
    .optional(),
  installedTargets: z.array(text).optional(),
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
const policyOccurrence = z.object({
  filePath: text,
  policy: z.literal('declaration-context'),
  requestIds: texts,
});
const contributionsRecord = z.object({
  occurrence: z.union([occurrenceSchema, policyOccurrence]),
  basis: z
    .object({ kind: z.literal('declaration-context'), evidence: text })
    .optional(),
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
  // The data codec validates this closed grammar without expanding shared nodes.
  data: z.unknown(),
  discovery: z.array(discoveryRecordSchema),
});

export function parseGraphRecords(value: unknown): AnalysisSnapshot['graphs'] {
  return z.record(text, graphRecord).parse(value) as AnalysisSnapshot['graphs'];
}
const lockDigest = z.string().regex(/^[a-f0-9]{64}$/);
const lockReceipt = z.tuple([text, lockDigest, text]);
const installationReceipt = z.object({
  root: text,
  configPath: text,
  kind: z.enum(['project', 'environment', 'location']),
  installationRoot: text,
  binding: text.optional(),
  manager: text,
  lockRoot: text,
  resolutionRoot: text,
  locks: z.array(lockReceipt).nonempty(),
});
const header = z.object({
  schema: z.literal(ANALYSIS_SCHEMA),
  implementation: z.literal(ANALYSIS_ADAPTER),
  identity: text,
  configVersion: text,
  revision: z.uuid(),
  baselineTime: z.number().nonnegative().optional(),
  installations: z.array(installationReceipt).optional(),
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
const resolvedConfig = z.object({
  configPath: text,
  context: text,
  discovery: z.array(discoveryRecordSchema).nonempty(),
  payload: text,
  fingerprint: text,
});
const snapshot = z.object({
  header,
  configModules: configModuleSnapshotSchema,
  authorities: z.record(text, authorityRecordSchema),
  resolvedConfigs: z.record(text, resolvedConfig),
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
