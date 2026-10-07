import { z } from 'zod';
const text = z.string();
const texts = z.array(text);
const dependency = z.object({ inputId: text, expectedVersion: text });
const dependencies = z.array(dependency);
const domain = z.object({
  adapter: z.literal('physical-installation-v1'),
  root: text,
  resolutionRoot: text,
  managerIdentity: text,
  manager: z.enum(['pnpm', 'npm', 'yarn', 'bun']),
  locks: texts,
  dependencies,
});
const environment = z.object({
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
  configPath: text,
  fileNames: texts,
  options,
  projectReferences: z.array(reference).optional(),
  admissionMode: z.enum(['full-program', 'root-facts']).optional(),
  analysisBinding: binding.optional(),
});
const boundaryEntry = z.tuple([text, z.boolean()]);
export const nativeContextSchema: z.ZodType<unknown> = z.object({
  project,
  sharedEnvironment: z.object({ dependencies, queryIds: texts, version: text }),
  environment,
  dependencies,
  queryIds: texts,
  boundary: z.array(boundaryEntry),
  sources: z.record(text, text.nullable()),
  complete: z.boolean(),
});
