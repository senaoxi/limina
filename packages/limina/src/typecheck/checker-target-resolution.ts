import { createRequire } from 'node:module';
import path from 'pathe';

import {
  type CheckerPackageResolver,
  collectMissingCheckerPeerDependencies,
  formatMissingCheckerPeerDependencies,
  getCheckerAdapter,
} from '#checkers';
import type {
  CheckerExecutionKind,
  ImportAnalysisConfig,
  ResolvedCheckerConfig,
} from '#config/runner';

export function getExecutionCheckers(options: {
  checkers: ResolvedCheckerConfig[];
  executionKind: CheckerExecutionKind;
}): ResolvedCheckerConfig[] {
  return options.checkers.filter((checker) => {
    const adapter = getCheckerAdapter(checker.preset);
    return adapter?.execution === options.executionKind;
  });
}

function getErrorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String(error.code)
    : undefined;
}

function handlePackageResolutionError(options: {
  error: unknown;
  packageName: string;
}): string | undefined {
  const code = getErrorCode(options.error);

  if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
    return options.packageName;
  }

  if (code === 'MODULE_NOT_FOUND') {
    return undefined;
  }

  throw options.error;
}

function resolvePackageFromRoot(options: {
  packageName: string;
  projectRootDir: string;
}): string | undefined {
  const requireFromRoot = createRequire(
    path.join(options.projectRootDir, 'package.json'),
  );

  try {
    return requireFromRoot.resolve(`${options.packageName}/package.json`);
  } catch (error) {
    return handlePackageResolutionError({
      error,
      packageName: options.packageName,
    });
  }
}

function collectVueCompilerSfcCheckers(options: {
  checkers: readonly ResolvedCheckerConfig[];
  imports: ImportAnalysisConfig | undefined;
}): ResolvedCheckerConfig[] {
  if (options.imports?.vue !== 'compiler-sfc') {
    return [];
  }

  return options.checkers.filter(
    (checker) => checker.preset === 'vue-tsc' || checker.preset === 'vue-tsgo',
  );
}

function appendVueCompilerSfcDependency(options: {
  checkers: readonly ResolvedCheckerConfig[];
  missingDependencies: ReturnType<typeof collectMissingCheckerPeerDependencies>;
  projectRootDir: string;
  resolvePackage: CheckerPackageResolver;
}): void {
  if (options.checkers.length === 0) {
    return;
  }

  const resolved = options.resolvePackage({
    packageName: '@vue/compiler-sfc',
    projectRootDir: options.projectRootDir,
  });

  if (resolved !== undefined) {
    return;
  }

  options.missingDependencies.push({
    checkerNames: options.checkers
      .map((checker) => checker.name)
      .sort((left, right) => left.localeCompare(right)),
    packageName: '@vue/compiler-sfc',
    reason: 'enabled by config.imports.vue: "compiler-sfc"',
  });
}

export function collectCheckerPeerDependencyProblems(options: {
  checkers: ResolvedCheckerConfig[];
  imports?: ImportAnalysisConfig;
  projectRootDir: string;
  resolvePackage?: CheckerPackageResolver;
}): string[] {
  const resolvePackage = options.resolvePackage ?? resolvePackageFromRoot;
  const missingDependencies = collectMissingCheckerPeerDependencies({
    checkers: options.checkers,
    projectRootDir: options.projectRootDir,
    resolvePackage,
  });
  const vueCheckers = collectVueCompilerSfcCheckers({
    checkers: options.checkers,
    imports: options.imports,
  });

  appendVueCompilerSfcDependency({
    checkers: vueCheckers,
    missingDependencies,
    projectRootDir: options.projectRootDir,
    resolvePackage,
  });

  return missingDependencies.length === 0
    ? []
    : [formatMissingCheckerPeerDependencies(missingDependencies)];
}
