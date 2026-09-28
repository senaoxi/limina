import type { PackageManifest } from '#core/workspace/actions';
import { normalizeSlashes, toRelativePath } from '#utils/path';
import { isPlainRecord } from '#utils/values';
import path from 'pathe';
import type { OwnerSourceModuleSet } from './unused/types';

type ManifestTargetCollector = (value: unknown) => string[];

function collectStringTarget(value: unknown): string[] {
  return typeof value === 'string' ? [value] : [];
}

function collectArrayTargets(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(collectManifestEntryTargets);
}

function collectRecordTargets(value: unknown): string[] {
  if (!isPlainRecord(value)) return [];
  return Object.values(value).flatMap(collectManifestEntryTargets);
}

const manifestTargetCollectors: readonly ManifestTargetCollector[] = [
  collectStringTarget,
  collectArrayTargets,
  collectRecordTargets,
];

export function collectManifestEntryTargets(value: unknown): string[] {
  for (const collector of manifestTargetCollectors) {
    const targets = collector(value);
    if (targets.length > 0) return targets;
  }
  return [];
}

export function collectPackageManifestEntryTargets(
  manifest: PackageManifest,
): string[] {
  const manifestRecord = manifest as Record<string, unknown>;
  const values = [
    manifestRecord.exports,
    manifestRecord.main,
    manifestRecord.module,
    manifestRecord.browser,
    manifestRecord.types,
    manifestRecord.typings,
    manifestRecord.bin,
  ];
  return [...new Set(values.flatMap(collectManifestEntryTargets))].sort();
}

function stripCurrentDirectoryPrefixes(value: string): string {
  let target = value;
  while (target.startsWith('./')) target = target.slice(2);
  return target;
}

function containsParentTraversal(target: string): boolean {
  return [
    target === '..',
    target.startsWith('../'),
    target.includes('/../'),
    target.endsWith('/..'),
  ].some(Boolean);
}

function isPackageJsonTarget(target: string): boolean {
  return target === 'package.json' || target.endsWith('/package.json');
}

function isAbsoluteTarget(target: string): boolean {
  return path.isAbsolute(target) || /^[A-Za-z]:[\\/]/u.test(target);
}

export function normalizeManifestTargetPath(value: string): string | null {
  const target = stripCurrentDirectoryPrefixes(normalizeSlashes(value.trim()));
  const invalid = [
    target.length === 0,
    target.includes('*'),
    isPackageJsonTarget(target),
    isAbsoluteTarget(target),
    containsParentTraversal(target),
  ].some(Boolean);
  return invalid ? null : target;
}

interface ExtensionReplacement {
  pattern: RegExp;
  replacements: readonly string[];
}

const extensionReplacements: readonly ExtensionReplacement[] = [
  { pattern: /\.d\.mts$/u, replacements: ['.mts'] },
  { pattern: /\.d\.cts$/u, replacements: ['.cts'] },
  { pattern: /\.d\.ts$/u, replacements: ['.ts'] },
  { pattern: /\.mjs$/u, replacements: ['.mts'] },
  { pattern: /\.cjs$/u, replacements: ['.cts'] },
  { pattern: /\.jsx$/u, replacements: ['.tsx', '.jsx'] },
  { pattern: /\.js$/u, replacements: ['.ts', '.tsx', '.js'] },
];

function replaceExtension(candidate: string): string[] {
  const replacement = extensionReplacements.find((entry) =>
    entry.pattern.test(candidate),
  );
  if (replacement === undefined) return [];
  return replacement.replacements.map((extension) =>
    candidate.replace(replacement.pattern, extension),
  );
}

function collectInitialCandidates(target: string): string[] {
  if (target.startsWith('dist/')) return [target, target.slice(5)];
  return [target];
}

function collectReplacementCandidates(candidates: readonly string[]): string[] {
  return candidates.flatMap(replaceExtension);
}

export function collectSourceCandidatesForManifestTarget(
  target: string,
): string[] {
  const initial = collectInitialCandidates(target);
  return [
    ...new Set([...initial, ...collectReplacementCandidates(initial)]),
  ].sort();
}

function createOwnerRelativeFileIndex(
  moduleSet: OwnerSourceModuleSet,
): Set<string> {
  return new Set(
    moduleSet.files.map((filePath) =>
      normalizeSlashes(toRelativePath(moduleSet.owner.directory, filePath)),
    ),
  );
}

function collectExistingCandidates(options: {
  files: ReadonlySet<string>;
  target: string;
}): string[] {
  return collectSourceCandidatesForManifestTarget(options.target).filter(
    (candidate) => options.files.has(candidate),
  );
}

export function collectManifestSourceEntryPatterns(
  moduleSet: OwnerSourceModuleSet,
): string[] {
  const files = createOwnerRelativeFileIndex(moduleSet);
  const normalizedTargets = collectPackageManifestEntryTargets(
    moduleSet.owner.manifest,
  )
    .map(normalizeManifestTargetPath)
    .filter((target): target is string => target !== null);
  return [
    ...new Set(
      normalizedTargets.flatMap((target) =>
        collectExistingCandidates({ files, target }),
      ),
    ),
  ].sort();
}
