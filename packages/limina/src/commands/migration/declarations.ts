import type { ResolvedLiminaConfig } from '#config/runner';
import { type JsonObject, resolveReferencePath } from '#core/tsconfig/actions';
import { isPlainRecord } from '#utils/values';
import path from 'pathe';
import {
  readImplicitRefs,
  readOutputOptions,
} from '../../core/build-graph/generated/config-readers';
import { relativeConfigPath } from './transform';

export interface MigrationRecord {
  kind: string;
  configPath: string;
  message: string;
  original?: unknown;
  details?: unknown;
}

export class MigrationInputError extends Error {}

interface DeclarationNormalization {
  config: ResolvedLiminaConfig;
  configPath: string;
  object: JsonObject;
  validTargets: ReadonlySet<string>;
  records: MigrationRecord[];
}

function normalizeOutputPath(
  options: DeclarationNormalization,
  outputs: JsonObject,
  field: string,
): void {
  const value = outputs[field];
  if (typeof value !== 'string' || !path.isAbsolute(value)) return;
  outputs[field] = relativeConfigPath(options.configPath, value);
  options.records.push({
    kind: 'normalized-output-path',
    configPath: options.configPath,
    original: value,
    message: `Rebased ${field} to the same absolute target.`,
  });
}

function normalizeOutputs(
  options: DeclarationNormalization,
  metadata: JsonObject,
): void {
  if (!isPlainRecord(metadata.outputs)) return;
  for (const field of ['outDir', 'rootDir'])
    normalizeOutputPath(options, metadata.outputs, field);
}

function wrapImplicitObject(
  options: DeclarationNormalization,
  metadata: JsonObject,
): void {
  if (
    !isPlainRecord(metadata.implicitRefs) ||
    typeof metadata.implicitRefs.path !== 'string'
  )
    return;
  options.records.push({
    kind: 'normalized-implicit-array',
    configPath: options.configPath,
    original: structuredClone(metadata.implicitRefs),
    message: 'Wrapped an explicit implicit reference in an array.',
  });
  metadata.implicitRefs = [metadata.implicitRefs];
}

function hasReadablePath(
  value: unknown,
): value is JsonObject & { path: string } {
  if (!isPlainRecord(value)) return false;
  return typeof value.path === 'string' && value.path.trim() !== '';
}

function needsReason(entry: JsonObject): boolean {
  if (entry.reason === undefined) return true;
  return typeof entry.reason === 'string' && entry.reason.trim() === '';
}

function normalizeReason(
  options: DeclarationNormalization,
  entry: JsonObject,
  original: JsonObject,
): void {
  if (!needsReason(entry)) return;
  entry.reason = '保留迁移前已有的显式 implicitRef；原声明未提供 reason';
  options.records.push({
    kind: 'normalized-implicit-reason',
    configPath: options.configPath,
    original,
    message: entry.reason as string,
  });
}

interface ImplicitNormalization {
  options: DeclarationNormalization;
  seen: Set<string>;
}

function shouldRemoveImplicit(
  context: ImplicitNormalization,
  target: string,
  original: JsonObject,
): boolean {
  if (
    target !== context.options.configPath &&
    context.options.validTargets.has(target)
  )
    return false;
  context.options.records.push({
    kind: 'removed-implicit-reference',
    configPath: context.options.configPath,
    original,
    message: 'Target is not a retained ordinary source config.',
    details: { target },
  });
  return true;
}

function deduplicateImplicit(
  context: ImplicitNormalization,
  target: string,
  original: JsonObject,
): boolean {
  if (!context.seen.has(target)) {
    context.seen.add(target);
    return false;
  }
  context.options.records.push({
    kind: 'duplicate-implicit-reference',
    configPath: context.options.configPath,
    original,
    message:
      'Retained the first declaration for this target, as the core reader does.',
  });
  return true;
}

function normalizeImplicitRecord(
  context: ImplicitNormalization,
  entry: JsonObject & { path: string },
): boolean {
  const original = structuredClone(entry);
  const target = resolveReferencePath(
    context.options.configPath,
    entry.path.trim(),
  );
  const removed = shouldRemoveImplicit(context, target, original);
  if (removed || deduplicateImplicit(context, target, original)) return false;
  normalizeImplicitPathAndReason(context.options, entry, original);
  return true;
}

function normalizeImplicitPathAndReason(
  options: DeclarationNormalization,
  entry: JsonObject & { path: string },
  original: JsonObject,
): void {
  if (path.isAbsolute(entry.path))
    entry.path = relativeConfigPath(
      options.configPath,
      resolveReferencePath(options.configPath, entry.path),
    );
  normalizeReason(options, entry, original);
}

function normalizeImplicitEntry(
  context: ImplicitNormalization,
  entry: unknown,
): boolean {
  // Malformed fields remain available to the formal reader's diagnostics.
  if (!hasReadablePath(entry)) return true;
  return normalizeImplicitRecord(context, entry);
}

function normalizeImplicit(
  options: DeclarationNormalization,
  metadata: JsonObject,
): void {
  wrapImplicitObject(options, metadata);
  if (!Array.isArray(metadata.implicitRefs)) return;
  const context = { options, seen: new Set<string>() };
  metadata.implicitRefs = metadata.implicitRefs.filter((entry) =>
    normalizeImplicitEntry(context, entry),
  );
}

function validateDeclarations(options: DeclarationNormalization): void {
  const virtualFiles = new Map(options.config.virtualFiles);
  virtualFiles.set(options.configPath, JSON.stringify(options.object));
  const config = { ...options.config, virtualFiles };
  const problems = [
    ...readOutputOptions(config, options.configPath, options.object).problems,
    ...readImplicitRefs(config, options.configPath).problems,
  ];
  if (problems.length > 0) throw new MigrationInputError(problems.join('\n\n'));
}

export function normalizeDeclarations(options: DeclarationNormalization): void {
  const metadata = options.object.liminaOptions;
  if (metadata === undefined) return;
  if (!isPlainRecord(metadata))
    throw new MigrationInputError(
      'liminaOptions must be an object; no unambiguous normalization exists.',
    );
  normalizeOutputs(options, metadata);
  normalizeImplicit(options, metadata);
  validateDeclarations(options);
}
