import { z } from 'zod';
import {
  declarationEntryDataSchema,
  declarationEntrySchema,
} from './declaration-schema';
import { dependencySchema as dependency } from './dependency-schema';
import { discoveryRecordSchema } from './discovery-schema';
import { nativeEvidenceSchema } from './native-evidence-schema';
const text = z.string();
const texts = z.array(text);
const dependencies = z.array(dependency);
const domain = z.object({
  adapter: z.literal('physical-installation-v2'),
  root: text,
  lockRoot: text,
  resolutionRoot: text,
  managerIdentity: text,
  manager: z.enum(['pnpm', 'npm', 'yarn', 'bun']),
  locks: texts,
  dependencies,
});
export const typeEnvironmentSchema: z.ZodType<unknown> = z.object({
  policy: z.literal('lockfile-and-local-roots-v1'),
  effectiveTypeRoots: texts,
  typeRootsHash: text,
  domains: z.array(domain),
  dependencies,
  evidence: z.enum(['observed', 'lockfile-trusted', 'unknown']),
  reason: text.optional(),
});
const reference = z.object({
  path: text,
  originalPath: text.optional(),
  prepend: z.boolean().optional(),
  circular: z.boolean().optional(),
});
const binding = z.object({
  phase: z.enum(['pending', 'locked']),
  checker: text,
});
const options = z.record(text, z.json());
const project = z.object({
  sourceConfigPath: text.optional(),
  configPath: text,
  fileNames: texts,
  options,
  projectReferences: z.array(reference).optional(),
  admissionMode: z
    .enum(['full-program', 'root-facts', 'coverage-bounded'])
    .optional(),
  analysisBinding: binding.optional(),
  compilationObligationScope: z
    .literal('generated-declaration-project-v1')
    .optional(),
});
const boundaryEntry = z.tuple([text, z.boolean()]);
const modulePremises = z.object({
  requestId: text,
  role: z.enum(['import', 'augmentation']),
  sourceFingerprint: text,
  sourceLoadGap: text.optional(),
  mode: z.number().optional(),
  options: options.optional(),
  sourceIsDeclaration: z.boolean(),
  sourceIsExternal: z.boolean(),
  excludedDocumentation: z.boolean(),
  ownAmbient: z.boolean(),
});

const compilerInventory = z.object({
  modules: z.array(modulePremises),
  members: texts,
  syntax: z.array(z.object({ file: text, fingerprint: text })),
  occurrences: z.array(z.object({ requestId: text, fingerprint: text })),
  loads: z.array(z.object({ requestId: text, target: text, source: text })),
  roots: z.array(z.object({ root: text, source: text })),
});
export const nativeContextSchema: z.ZodType<unknown> = z
  .object({
    native: z
      .object({
        snapshot: nativeEvidenceSchema,
        inventory: compilerInventory,
        discovery: z.array(discoveryRecordSchema),
        boundaryIdentity: text,
      })
      .optional(),
    typeEntries: z.array(declarationEntryDataSchema),
    collection: z
      .object({
        adapter: z.literal('native-requests-v1'),
        mode: z.enum(['programless', 'compatibility']),
        reason: text.optional(),
      })
      .optional(),
    project,
    sharedEnvironment: z.object({
      dependencies,
      queryIds: texts,
      version: text,
    }),
    environment: typeEnvironmentSchema,
    dependencies,
    queryIds: texts,
    boundary: z.array(boundaryEntry),
    sources: z.record(text, text.nullable()),
    complete: z.boolean(),
  })
  .refine(
    (context) =>
      context.native !== undefined ||
      context.typeEntries.every(
        (entry) => declarationEntrySchema.safeParse(entry).success,
      ),
  );
