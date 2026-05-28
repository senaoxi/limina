import { createRequire } from 'node:module';
import path from 'node:path';
import type {
  BuiltinCheckerPreset,
  CheckerConfig,
  CheckerExecutionKind,
  ResolvedCheckerConfig,
} from './config';
import { toRelativePath } from './utils/path';

const typeScriptCheckerExtensions = [
  '.ts',
  '.tsx',
  '.cts',
  '.mts',
  '.d.ts',
  '.d.cts',
  '.d.mts',
  '.json',
] as const;

export interface CheckerCommandTarget {
  args: string[];
  command: string;
  label: string;
}

export interface CheckerCommandTargetOptions {
  checker: ResolvedCheckerConfig;
  commandOverride?: string;
  configPath: string;
  executionKind: CheckerExecutionKind;
  projectRootDir: string;
}

export interface CheckerAdapter {
  createCommandTarget: (
    options: CheckerCommandTargetOptions,
  ) => CheckerCommandTarget;
  defaultExtensions: string[];
  execution: CheckerExecutionKind;
  packageNames: string[];
  preset: BuiltinCheckerPreset;
  sourceGraph: boolean;
  tier: 'first-class' | 'source-only';
}

export interface MissingCheckerPeerDependency {
  checkerNames: string[];
  packageName: string;
}

export type CheckerPackageResolver = (options: {
  packageName: string;
  projectRootDir: string;
}) => string | undefined;

function createTscCommandTarget(
  options: CheckerCommandTargetOptions,
): CheckerCommandTarget {
  const relativeConfigPath = toRelativePath(
    options.projectRootDir,
    options.configPath,
  );

  return {
    args: ['-b', relativeConfigPath, '--pretty', 'false'],
    command: options.commandOverride ?? 'tsc',
    label: `tsc -b ${relativeConfigPath}`,
  };
}

function createTsgoCommandTarget(
  options: CheckerCommandTargetOptions,
): CheckerCommandTarget {
  const relativeConfigPath = toRelativePath(
    options.projectRootDir,
    options.configPath,
  );

  return {
    args: ['-b', relativeConfigPath, '--pretty', 'false'],
    command: 'tsgo',
    label: `tsgo -b ${relativeConfigPath}`,
  };
}

function createVueTscCommandTarget(
  options: CheckerCommandTargetOptions,
): CheckerCommandTarget {
  const relativeConfigPath = toRelativePath(
    options.projectRootDir,
    options.configPath,
  );

  return {
    args: ['-b', relativeConfigPath, '--pretty', 'false'],
    command: 'vue-tsc',
    label: `${options.checker.name}: vue-tsc -b ${relativeConfigPath}`,
  };
}

function createVueTsgoCommandTarget(
  options: CheckerCommandTargetOptions,
): CheckerCommandTarget {
  const relativeConfigPath = toRelativePath(
    options.projectRootDir,
    options.configPath,
  );

  /**
   * vue-tsgo exposes a --build flag, but in current releases that mode
   * generates a transient virtual TS workspace and asks tsgo's LSP for
   * diagnostics. It does not preserve TypeScript project-reference boundaries
   * or provide incremental build semantics, so Limina only uses vue-tsgo as a
   * source-only execution checker while still using its tsconfig entry for
   * Limina's own graph and proof coverage. Prefer vue-tsc for first-class Vue
   * build checks.
   */
  return {
    args: ['--project', relativeConfigPath],
    command: 'vue-tsgo',
    label: `${options.checker.name}: vue-tsgo --project ${relativeConfigPath}`,
  };
}

function createSvelteCheckCommandTarget(
  options: CheckerCommandTargetOptions,
): CheckerCommandTarget {
  const relativeConfigPath = toRelativePath(
    options.projectRootDir,
    options.configPath,
  );

  return {
    args: ['--tsconfig', relativeConfigPath],
    command: 'svelte-check',
    label: `${options.checker.name}: svelte-check --tsconfig ${relativeConfigPath}`,
  };
}

const builtinCheckerAdapters = {
  'svelte-check': {
    createCommandTarget: createSvelteCheckCommandTarget,
    defaultExtensions: ['.svelte'],
    execution: 'typecheck',
    packageNames: ['svelte-check'],
    preset: 'svelte-check',
    sourceGraph: false,
    tier: 'source-only',
  },
  tsc: {
    createCommandTarget: createTscCommandTarget,
    defaultExtensions: [...typeScriptCheckerExtensions],
    execution: 'build',
    packageNames: ['typescript'],
    preset: 'tsc',
    sourceGraph: true,
    tier: 'first-class',
  },
  tsgo: {
    createCommandTarget: createTsgoCommandTarget,
    defaultExtensions: [...typeScriptCheckerExtensions],
    execution: 'build',
    packageNames: ['@typescript/native-preview'],
    preset: 'tsgo',
    sourceGraph: true,
    tier: 'first-class',
  },
  'vue-tsc': {
    createCommandTarget: createVueTscCommandTarget,
    defaultExtensions: ['.vue'],
    execution: 'build',
    packageNames: ['vue-tsc', '@vue/compiler-sfc'],
    preset: 'vue-tsc',
    sourceGraph: true,
    tier: 'first-class',
  },
  'vue-tsgo': {
    createCommandTarget: createVueTsgoCommandTarget,
    defaultExtensions: ['.vue'],
    execution: 'typecheck',
    packageNames: ['vue-tsgo', '@typescript/native-preview'],
    preset: 'vue-tsgo',
    sourceGraph: true,
    tier: 'source-only',
  },
} satisfies Record<BuiltinCheckerPreset, CheckerAdapter>;

export function isBuiltinCheckerPreset(
  value: string,
): value is BuiltinCheckerPreset {
  return Object.hasOwn(builtinCheckerAdapters, value);
}

export function getCheckerAdapter(preset: string): CheckerAdapter | null {
  return isBuiltinCheckerPreset(preset) ? builtinCheckerAdapters[preset] : null;
}

export function resolveCheckerPackageFromRoot(options: {
  packageName: string;
  projectRootDir: string;
}): string | undefined {
  const requireFromRoot = createRequire(
    path.join(options.projectRootDir, 'package.json'),
  );

  try {
    return requireFromRoot.resolve(`${options.packageName}/package.json`);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
    ) {
      return options.packageName;
    }

    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'MODULE_NOT_FOUND'
    ) {
      return undefined;
    }

    throw error;
  }
}

export function collectMissingCheckerPeerDependencies(options: {
  checkers: ResolvedCheckerConfig[];
  projectRootDir: string;
  resolvePackage?: CheckerPackageResolver;
}): MissingCheckerPeerDependency[] {
  const resolvePackage =
    options.resolvePackage ?? resolveCheckerPackageFromRoot;
  const missingCheckersByPackage = new Map<string, Set<string>>();

  for (const checker of options.checkers) {
    const packageNames = getCheckerAdapter(checker.preset)?.packageNames ?? [];

    for (const packageName of packageNames) {
      if (
        resolvePackage({
          packageName,
          projectRootDir: options.projectRootDir,
        })
      ) {
        continue;
      }

      const checkerNames =
        missingCheckersByPackage.get(packageName) ?? new Set<string>();

      checkerNames.add(checker.name);
      missingCheckersByPackage.set(packageName, checkerNames);
    }
  }

  return [...missingCheckersByPackage.entries()]
    .map(([packageName, checkerNames]) => ({
      checkerNames: [...checkerNames].sort((left, right) =>
        left.localeCompare(right),
      ),
      packageName,
    }))
    .sort((left, right) => left.packageName.localeCompare(right.packageName));
}

export function formatMissingCheckerPeerDependencies(
  missingDependencies: MissingCheckerPeerDependency[],
): string {
  const packageNames = missingDependencies.map(
    (dependency) => dependency.packageName,
  );

  return [
    'Missing checker peer dependencies:',
    ...missingDependencies.map((dependency) => {
      const checkerList = dependency.checkerNames
        .map((checkerName) => `"${checkerName}"`)
        .join(', ');

      return `  - ${dependency.packageName} (used by checker ${checkerList})`;
    }),
    `Fix: pnpm add -D ${packageNames.join(' ')}`,
  ].join('\n');
}

export function getCheckerExtensions(checker: CheckerConfig): string[] {
  const adapter = getCheckerAdapter(checker.preset);

  if (adapter) {
    return normalizeExtensions(adapter.defaultExtensions);
  }

  throw new Error(`Checker preset "${checker.preset}" is not supported.`);
}

export function getResolvedCheckers(config: {
  config?: { checkers?: Record<string, CheckerConfig> };
}): ResolvedCheckerConfig[] {
  const checkers = config.config?.checkers;

  if (!checkers) {
    return [];
  }

  return Object.entries(checkers)
    .map(([name, checker]) => ({
      entry: checker.entry.trim(),
      extensions: getCheckerExtensions(checker),
      name,
      preset: checker.preset,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function normalizeExtensions(extensions: string[]): string[] {
  return [...new Set(extensions)].sort((left, right) => {
    const lengthDelta = right.length - left.length;

    return lengthDelta === 0 ? left.localeCompare(right) : lengthDelta;
  });
}
