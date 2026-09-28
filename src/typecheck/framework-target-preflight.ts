import { existsSync } from 'node:fs';

import type {
  CheckerDependencyCategory,
  CheckerDependencyRequirement,
  CheckerPackageResolver,
} from '#checkers';
import { normalizeSlashes, toRelativePath } from '#utils/path';
import path from 'pathe';
import {
  findUnsupportedExternalCheckers,
  type UnsupportedExternalChecker,
} from './framework-external-checker-compatibility';
import { resolveFrameworkPackageFromRoot } from './framework-package-resolution';
import type { TypecheckTarget } from './target-types';

type FrameworkFamily = NonNullable<TypecheckTarget['checkerFamily']>;

export interface FrameworkTargetPreflightFailure {
  checkerName: string;
  family: FrameworkFamily;
  problems: string[];
}

const dependencyCategoryLabels: Record<CheckerDependencyCategory, string> = {
  'checker-binary': 'checker binary',
  'checker-runtime': 'checker runtime dependency',
  'external-checker': 'external checker',
  'limina-runtime': 'Limina runtime',
};

function quoteCommandPath(value: string): string {
  return /\s/u.test(value) ? JSON.stringify(value) : value;
}

function relativePath(workspaceRootDir: string, filePath: string): string {
  return normalizeSlashes(toRelativePath(workspaceRootDir, filePath));
}

function createLeafCommandPrefix(
  workspaceRootDir: string,
  dependencyRootDir: string,
): string {
  const relativeRoot = relativePath(workspaceRootDir, dependencyRootDir);
  return relativeRoot === '.'
    ? 'pnpm '
    : `pnpm --dir ${quoteCommandPath(relativeRoot)} `;
}

function createLeafInstallCommand(options: {
  dependencyRootDir: string;
  packageNames: readonly string[];
  workspaceRootDir: string;
}): string {
  return `${createLeafCommandPrefix(
    options.workspaceRootDir,
    options.dependencyRootDir,
  )}add -D ${options.packageNames.join(' ')}`;
}

function formatMissingFrameworkDependencies(options: {
  missing: readonly CheckerDependencyRequirement[];
  target: TypecheckTarget;
  workspaceRootDir: string;
}): string {
  const sourceConfigPath = options.target.sourceConfigPath!;
  const dependencyRootDir = options.target.dependencyRootDir!;
  const missingLines = options.missing.flatMap((requirement) => [
    `  missing package: ${requirement.packageName}`,
    `  dependency category: ${dependencyCategoryLabels[requirement.category]}`,
  ]);
  return [
    'Missing framework checker dependencies:',
    `  checker family: ${options.target.checkerFamily}`,
    `  checker: ${options.target.checkerName}`,
    `  source config: ${relativePath(options.workspaceRootDir, sourceConfigPath)}`,
    `  leaf package root: ${relativePath(options.workspaceRootDir, dependencyRootDir)}`,
    ...missingLines,
    `Fix: ${createLeafInstallCommand({
      dependencyRootDir,
      packageNames: options.missing.map(
        (requirement) => requirement.packageName,
      ),
      workspaceRootDir: options.workspaceRootDir,
    })}`,
  ].join('\n');
}

function formatMissingExternalCheckers(options: {
  missing: readonly CheckerDependencyRequirement[];
  target: TypecheckTarget;
  workspaceRootDir: string;
}): string {
  const dependencyRootDir = options.target.dependencyRootDir!;
  const packageNames = options.missing.map(
    (requirement) => requirement.packageName,
  );
  return [
    'Missing external checker:',
    `  checker family: ${options.target.checkerFamily}`,
    `  checker execution scope: ${relativePath(options.workspaceRootDir, dependencyRootDir)}`,
    ...packageNames.map((packageName) => `  missing package: ${packageName}`),
    `Fix: ${createLeafInstallCommand({
      dependencyRootDir,
      packageNames,
      workspaceRootDir: options.workspaceRootDir,
    })}`,
  ].join('\n');
}

function formatUnsupportedExternalCheckers(options: {
  target: TypecheckTarget;
  unsupported: readonly UnsupportedExternalChecker[];
  workspaceRootDir: string;
}): string {
  const dependencyRootDir = options.target.dependencyRootDir!;
  return [
    'Unsupported external checker:',
    `  checker family: ${options.target.checkerFamily}`,
    `  checker execution scope: ${relativePath(options.workspaceRootDir, dependencyRootDir)}`,
    ...options.unsupported.flatMap((checker) => [
      `  package: ${checker.packageName}`,
      `  installed version: ${checker.version}`,
      `  supported range: ${checker.supportedRange}`,
    ]),
    `Fix: adjust ${options.unsupported
      .map((checker) => checker.packageName)
      .join(' ')} in this checker execution scope.`,
  ].join('\n');
}

function formatMissingAstroTypes(options: {
  target: TypecheckTarget;
  workspaceRootDir: string;
}): string {
  const dependencyRootDir = options.target.dependencyRootDir!;
  const generatedTypesPath = path.join(dependencyRootDir, '.astro/types.d.ts');
  return [
    'Astro generated types are missing:',
    '  checker family: astro',
    `  source config: ${relativePath(options.workspaceRootDir, options.target.sourceConfigPath!)}`,
    `  leaf package root: ${relativePath(options.workspaceRootDir, dependencyRootDir)}`,
    `  expected generated type: ${relativePath(options.workspaceRootDir, generatedTypesPath)}`,
    'Limina never runs Astro sync automatically.',
    `Fix: ${createLeafCommandPrefix(options.workspaceRootDir, dependencyRootDir)}exec astro sync`,
  ].join('\n');
}

function findMissingRequirements(options: {
  resolvePackage: CheckerPackageResolver;
  target: TypecheckTarget;
}): CheckerDependencyRequirement[] {
  return (options.target.dependencyRequirements ?? []).filter(
    (requirement) =>
      options.resolvePackage({
        packageName: requirement.packageName,
        projectRootDir: options.target.dependencyRootDir!,
      }) === undefined,
  );
}

function appendMissingDependencies(
  problems: string[],
  options: Parameters<typeof collectTargetProblems>[0],
): void {
  const missing = findMissingRequirements(options);
  const externalCheckers = missing.filter(
    (requirement) => requirement.category === 'external-checker',
  );
  const frameworkDependencies = missing.filter(
    (requirement) => requirement.category !== 'external-checker',
  );
  if (externalCheckers.length > 0) {
    problems.push(
      formatMissingExternalCheckers({
        ...options,
        missing: externalCheckers,
      }),
    );
  }
  if (frameworkDependencies.length > 0) {
    problems.push(
      formatMissingFrameworkDependencies({
        ...options,
        missing: frameworkDependencies,
      }),
    );
  }
}

function appendUnsupportedExternalCheckers(
  problems: string[],
  options: Parameters<typeof collectTargetProblems>[0],
): void {
  const unsupported = findUnsupportedExternalCheckers(options);
  if (unsupported.length === 0) return;
  problems.push(formatUnsupportedExternalCheckers({ ...options, unsupported }));
}

function hasMissingAstroTypes(
  options: Parameters<typeof collectTargetProblems>[0],
): boolean {
  if (options.target.checkerFamily !== 'astro') return false;
  return !options.generatedTypeExists(
    path.join(options.target.dependencyRootDir!, '.astro/types.d.ts'),
  );
}

function appendMissingAstroTypes(
  problems: string[],
  options: Parameters<typeof collectTargetProblems>[0],
): void {
  if (hasMissingAstroTypes(options)) {
    problems.push(formatMissingAstroTypes(options));
  }
}

function collectTargetProblems(options: {
  generatedTypeExists: (filePath: string) => boolean;
  resolvePackage: CheckerPackageResolver;
  target: TypecheckTarget;
  workspaceRootDir: string;
}): string[] {
  const problems: string[] = [];
  appendMissingDependencies(problems, options);
  appendUnsupportedExternalCheckers(problems, options);
  appendMissingAstroTypes(problems, options);
  return problems;
}

function createTargetFailure(options: {
  generatedTypeExists: (filePath: string) => boolean;
  resolvePackage: CheckerPackageResolver;
  target: TypecheckTarget;
  workspaceRootDir: string;
}): FrameworkTargetPreflightFailure[] {
  if (options.target.checkerFamily === undefined) return [];
  const problems = collectTargetProblems(options);
  if (problems.length === 0) return [];
  return [
    {
      checkerName: options.target.checkerName!,
      family: options.target.checkerFamily,
      problems,
    },
  ];
}

export function collectFrameworkTargetPreflightFailures(options: {
  generatedTypeExists?: (filePath: string) => boolean;
  resolvePackage?: CheckerPackageResolver;
  targets: readonly TypecheckTarget[];
  workspaceRootDir: string;
}): FrameworkTargetPreflightFailure[] {
  const generatedTypeExists = options.generatedTypeExists ?? existsSync;
  const resolvePackage =
    options.resolvePackage ?? resolveFrameworkPackageFromRoot;
  return options.targets.flatMap((target) =>
    createTargetFailure({
      generatedTypeExists,
      resolvePackage,
      target,
      workspaceRootDir: options.workspaceRootDir,
    }),
  );
}
