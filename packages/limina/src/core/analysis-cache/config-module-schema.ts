import { z } from 'zod';
import type { ConfigModuleFile, ConfigModuleSnapshot } from './contracts';
const text = z.string();
const metadata = z.object({
  kind: z.enum(['file', 'missing']),
  mtimeMs: z.number().optional(),
  ctimeMs: z.number().optional(),
  size: z.number().nonnegative().optional(),
  dev: z.number().optional(),
  ino: z.number().optional(),
  mode: z.number().optional(),
});
const source = z.object({
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
});
const file = z.object({
  path: text,
  logicalPath: text.optional(),
  logicalBinding: text.optional(),
  role: z.enum(['module', 'anchor', 'dependency']),
  binding: text,
  metadata,
  contentHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  format: text.nullable(),
  sourceKind: z.enum(['disk', 'loader']).optional(),
  loadedSource: source.optional(),
});
const resolution = z.object({
  parentURL: text,
  specifier: text,
  resolvedURL: text,
  conditions: z.array(text),
  importAttributes: z.record(text, text),
  requestBinding: z.object({ path: text, binding: text }).optional(),
});
const dependency = z.object({ path: text, resolvedPath: text, binding: text });
function hasDuplicates(values: string[]): boolean {
  return new Set(values).size !== values.length;
}
function isInvalidMissingFile(entry: ConfigModuleFile): boolean {
  return (
    entry.metadata.kind === 'missing' &&
    [entry.role === 'module', entry.contentHash !== null].some(Boolean)
  );
}
function hasUnknownContent(entry: ConfigModuleFile): boolean {
  return entry.metadata.kind === 'file' && entry.contentHash === null;
}
function hasUnknownFormat(entry: ConfigModuleFile): boolean {
  return entry.role === 'module' && entry.format === null;
}
function isUnknownFile(entry: ConfigModuleFile): boolean {
  return [
    hasUnknownContent(entry),
    hasUnknownFormat(entry),
    entry.role === 'module' && entry.sourceKind === undefined,
    entry.sourceKind === 'loader' && entry.loadedSource === undefined,
  ].some(Boolean);
}
function hasInvalidDependencies(snapshot: ConfigModuleSnapshot): boolean {
  const paths = new Set(snapshot.files.map((entry) => entry.path));
  return snapshot.dependencies.some((entry) => !paths.has(entry.resolvedPath));
}
function hasInvalidCompleteMarker(snapshot: ConfigModuleSnapshot): boolean {
  if (!snapshot.complete) return false;
  return [
    snapshot.otherUnknownReasons.length > 0,
    snapshot.files.some(isUnknownFile),
  ].some(Boolean);
}
function isInvalidSnapshot(snapshot: ConfigModuleSnapshot): boolean {
  const keys = snapshot.resolutions.map((edge) =>
    JSON.stringify([
      edge.parentURL,
      edge.specifier,
      edge.conditions,
      edge.importAttributes,
    ]),
  );
  return [
    hasDuplicates(snapshot.files.map((entry) => entry.path)),
    hasDuplicates(keys),
    snapshot.files.some(isInvalidMissingFile),
    hasDuplicates(snapshot.dependencies.map((entry) => entry.path)),
    hasInvalidDependencies(snapshot),
    hasInvalidCompleteMarker(snapshot),
  ].some(Boolean);
}
export const configModuleSnapshotSchema: z.ZodType<ConfigModuleSnapshot> = z
  .object({
    loader: text,
    files: z.array(file),
    resolutions: z.array(resolution),
    complete: z.boolean(),
    dependencies: z.array(dependency),
    otherUnknownReasons: z.array(text),
  })
  .superRefine((snapshot, context) => {
    if (isInvalidSnapshot(snapshot))
      context.addIssue({
        code: 'custom',
        message: 'Inconsistent configuration module coverage.',
      });
  });
