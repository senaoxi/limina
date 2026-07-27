import type { RuntimeEnvironment } from '#config/runner';
import { getPackageRootSpecifier } from '#core/workspace/actions';
import { isPathInsideDirectory, normalizeAbsolutePath } from '#utils/path';
import { existsSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'pathe';
import type { DistPackageJson, SelfSpecifierMatchers } from './manifest';
import { findPackageImportTargets, isAllowedSelfSpecifier } from './manifest';

const nodeBuiltinSpecifiers = new Set(
  builtinModules.flatMap((specifier) =>
    specifier.startsWith('node:')
      ? [specifier, specifier.slice('node:'.length)]
      : [specifier, `node:${specifier}`],
  ),
);

export interface PublishedSpecifierValidationOptions {
  allowedExternalPackages: Set<string>;
  environment: RuntimeEnvironment;
  importsField: DistPackageJson['imports'];
  outDir: string;
  packageName: string;
  selfSpecifiers: SelfSpecifierMatchers;
  specifier: string;
}

type SpecifierKind = 'builtin' | 'local' | 'package' | 'package-import';
type ImportTargetKind =
  | 'invalid'
  | 'null'
  | 'package'
  | 'relative'
  | 'unsupported';

function hasAnyPrefix(value: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

function isRelativeOrAbsoluteSpecifier(specifier: string): boolean {
  return hasAnyPrefix(specifier, [
    '.',
    '/',
    'file:',
    'http:',
    'https:',
    'data:',
  ]);
}

const specifierKindMatchers: readonly {
  kind: Exclude<SpecifierKind, 'package'>;
  matches: (specifier: string) => boolean;
}[] = [
  { kind: 'package-import', matches: (specifier) => specifier.startsWith('#') },
  { kind: 'local', matches: isRelativeOrAbsoluteSpecifier },
  {
    kind: 'builtin',
    matches: (specifier) => nodeBuiltinSpecifiers.has(specifier),
  },
];

function getSpecifierKind(specifier: string): SpecifierKind {
  const match = specifierKindMatchers.find((entry) => entry.matches(specifier));
  return match === undefined ? 'package' : match.kind;
}

function getNonStringTargetKind(target: unknown): ImportTargetKind | null {
  if (target === null) return 'null';
  if (typeof target !== 'string') return 'invalid';
  return null;
}

const stringTargetKindMatchers: readonly {
  kind: Exclude<ImportTargetKind, 'null' | 'package'>;
  matches: (target: string) => boolean;
}[] = [
  { kind: 'invalid', matches: (target) => target.trim().length === 0 },
  { kind: 'relative', matches: (target) => target.startsWith('.') },
  { kind: 'unsupported', matches: (target) => target.startsWith('#') },
  { kind: 'unsupported', matches: isRelativeOrAbsoluteSpecifier },
];

function getStringTargetKind(target: string): ImportTargetKind {
  const match = stringTargetKindMatchers.find((entry) => entry.matches(target));
  return match === undefined ? 'package' : match.kind;
}

function getImportTargetKind(target: unknown): ImportTargetKind {
  const nonStringKind = getNonStringTargetKind(target);
  if (nonStringKind !== null) return nonStringKind;
  return getStringTargetKind(target as string);
}

function validateRelativeImportTarget(options: {
  outDir: string;
  specifier: string;
  target: string;
}): string | null {
  const absoluteTarget = normalizeAbsolutePath(
    path.resolve(options.outDir, options.target),
  );
  if (!isPathInsideDirectory(absoluteTarget, options.outDir)) {
    return `package import "${options.specifier}" target "${options.target}" escapes the published package root`;
  }
  if (!existsSync(absoluteTarget)) {
    return `package import "${options.specifier}" target "${options.target}" is not present in the published package`;
  }
  return null;
}

interface ImportTargetValidationOptions {
  key: string;
  source: PublishedSpecifierValidationOptions;
  target: unknown;
}

type ImportTargetValidator = (
  options: ImportTargetValidationOptions,
) => string | null;

function validateNullTarget(options: ImportTargetValidationOptions): string {
  return `package import "${options.source.specifier}" is forbidden by the null target in output package.json imports key "${options.key}"`;
}

function validateInvalidTarget(options: ImportTargetValidationOptions): string {
  return `package import "${options.source.specifier}" has an invalid target in output package.json imports key "${options.key}"`;
}

function validateRelativeTarget(
  options: ImportTargetValidationOptions,
): string | null {
  return validateRelativeImportTarget({
    outDir: options.source.outDir,
    specifier: options.source.specifier,
    target: options.target as string,
  });
}

function validateUnsupportedTarget(
  options: ImportTargetValidationOptions,
): string {
  return `package import "${options.source.specifier}" has unsupported target "${String(options.target)}"`;
}

function validatePackageTarget(
  options: ImportTargetValidationOptions,
): string | null {
  const target = options.target as string;
  const problem = validatePublishedSpecifier({
    ...options.source,
    importsField: undefined,
    specifier: target,
  });
  if (problem === null) return null;
  return `package import "${options.source.specifier}" target "${target}" is invalid: ${problem}`;
}

const importTargetValidators: Record<ImportTargetKind, ImportTargetValidator> =
  {
    invalid: validateInvalidTarget,
    null: validateNullTarget,
    package: validatePackageTarget,
    relative: validateRelativeTarget,
    unsupported: validateUnsupportedTarget,
  };

function validatePackageImportTarget(
  options: ImportTargetValidationOptions,
): string | null {
  return importTargetValidators[getImportTargetKind(options.target)](options);
}

function findImportTargetProblem(options: {
  key: string;
  source: PublishedSpecifierValidationOptions;
  targets: readonly unknown[];
}): string | null {
  for (const target of options.targets) {
    const problem = validatePackageImportTarget({ ...options, target });
    if (problem !== null) return problem;
  }
  return null;
}

function validatePackageImportSpecifier(
  options: PublishedSpecifierValidationOptions,
): string | null {
  const match = findPackageImportTargets(
    options.importsField,
    options.specifier,
  );
  if (match === null) {
    return `package import "${options.specifier}" is not declared by output package.json imports`;
  }
  return findImportTargetProblem({
    key: match.key,
    source: options,
    targets: match.targets,
  });
}

function validateBuiltinSpecifier(
  options: PublishedSpecifierValidationOptions,
): string | null {
  if (options.environment === 'node') return null;
  return `browser/runtime output must not import Node builtin "${options.specifier}"`;
}

function validateSelfSpecifier(options: {
  selfSpecifiers: SelfSpecifierMatchers;
  specifier: string;
}): string | null {
  if (isAllowedSelfSpecifier(options.specifier, options.selfSpecifiers)) {
    return null;
  }
  return `self import "${options.specifier}" is not exposed by output package.json exports`;
}

function validatePackageSpecifier(
  options: PublishedSpecifierValidationOptions,
): string | null {
  const packageRoot = getPackageRootSpecifier(options.specifier);
  if (packageRoot === options.packageName) {
    return validateSelfSpecifier(options);
  }
  if (options.allowedExternalPackages.has(packageRoot)) return null;
  return `"${options.specifier}" resolves to package "${packageRoot}" which is not listed in dependencies, peerDependencies, optionalDependencies, or self exports`;
}

const validators: Record<
  SpecifierKind,
  (options: PublishedSpecifierValidationOptions) => string | null
> = {
  builtin: validateBuiltinSpecifier,
  local: () => null,
  package: validatePackageSpecifier,
  'package-import': validatePackageImportSpecifier,
};

export function validatePublishedSpecifier(
  options: PublishedSpecifierValidationOptions,
): string | null {
  return validators[getSpecifierKind(options.specifier)](options);
}
