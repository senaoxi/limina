import type { CheckerDependencyRequirement } from '#checkers';
import type {
  FrameworkCheckerName,
  ResolvedLiminaConfig,
} from '#config/runner';
import type {
  FrameworkCapabilityDescriptor,
  GeneratedTsconfigGraphResult,
} from '#core/build-graph/runner';
import { compareCodeUnits } from '#utils/collections';
import {
  normalizeAbsolutePath,
  normalizeSlashes,
  toRelativePath,
} from '#utils/path';
import { createCheckerTargetId, type TypecheckTarget } from './target-types';

type FrameworkFamily = FrameworkCapabilityDescriptor['family'];

const frameworkRequirements = {
  astro: [
    { category: 'checker-binary', packageName: 'astro' },
    { category: 'checker-binary', packageName: '@astrojs/check' },
    { category: 'checker-runtime', packageName: 'typescript' },
  ],
  svelte: [
    { category: 'external-checker', packageName: 'svelte-check' },
    { category: 'checker-runtime', packageName: 'svelte' },
    { category: 'checker-runtime', packageName: 'svelte2tsx' },
    { category: 'checker-runtime', packageName: 'typescript' },
  ],
} as const satisfies Record<
  FrameworkFamily,
  readonly CheckerDependencyRequirement[]
>;

function frameworkCheckerName(family: FrameworkFamily): FrameworkCheckerName {
  return family === 'svelte' ? 'svelte-check' : 'astro';
}

function descriptorKey(
  descriptor: Pick<
    FrameworkCapabilityDescriptor,
    'family' | 'sourceConfigPath'
  >,
): string {
  return `${descriptor.family}\0${normalizeAbsolutePath(
    descriptor.sourceConfigPath,
  )}`;
}

function compareDescriptors(
  left: FrameworkCapabilityDescriptor,
  right: FrameworkCapabilityDescriptor,
): number {
  return (
    compareCodeUnits(left.sourceConfigPath, right.sourceConfigPath) ||
    compareCodeUnits(left.family, right.family) ||
    compareCodeUnits(left.packageRootDir, right.packageRootDir)
  );
}

function normalizeDescriptor(
  capability: FrameworkCapabilityDescriptor,
): FrameworkCapabilityDescriptor {
  return {
    family: capability.family,
    packageRootDir: normalizeAbsolutePath(capability.packageRootDir),
    sourceConfigPath: normalizeAbsolutePath(capability.sourceConfigPath),
  };
}

function hasDependencyRootDrift(
  current: FrameworkCapabilityDescriptor | undefined,
  descriptor: FrameworkCapabilityDescriptor,
): boolean {
  if (current === undefined) return false;
  return current.packageRootDir !== descriptor.packageRootDir;
}

function registerDescriptor(
  descriptorsByKey: Map<string, FrameworkCapabilityDescriptor>,
  capability: FrameworkCapabilityDescriptor,
): void {
  const descriptor = normalizeDescriptor(capability);
  const key = descriptorKey(descriptor);
  const current = descriptorsByKey.get(key);
  if (hasDependencyRootDrift(current, descriptor)) {
    throw new Error(
      `Framework capability dependency root drifted for ${descriptor.family} at ${descriptor.sourceConfigPath}.`,
    );
  }
  descriptorsByKey.set(key, descriptor);
}

function collectGraphCapabilities(
  generatedGraph: GeneratedTsconfigGraphResult,
): FrameworkCapabilityDescriptor[] {
  return [...generatedGraph.governedSources.values()].flatMap(
    (governedSources) =>
      [...governedSources.values()].flatMap(
        (governedSource) => governedSource.frameworkCapabilities,
      ),
  );
}

export function collectFrameworkCapabilityDescriptors(
  generatedGraph: GeneratedTsconfigGraphResult,
): FrameworkCapabilityDescriptor[] {
  const descriptorsByKey = new Map<string, FrameworkCapabilityDescriptor>();
  for (const capability of collectGraphCapabilities(generatedGraph)) {
    registerDescriptor(descriptorsByKey, capability);
  }
  return [...descriptorsByKey.values()].sort(compareDescriptors);
}

function createFrameworkCommandTarget(
  descriptor: FrameworkCapabilityDescriptor,
): Pick<TypecheckTarget, 'args' | 'command' | 'label'> {
  if (descriptor.family === 'astro') {
    return {
      args: [
        'check',
        '--noSync',
        '--root',
        descriptor.packageRootDir,
        '--tsconfig',
        descriptor.sourceConfigPath,
      ],
      command: 'astro',
      label: `astro-check: ${descriptor.sourceConfigPath}`,
    };
  }

  return {
    args: [
      '--workspace',
      descriptor.packageRootDir,
      '--tsconfig',
      descriptor.sourceConfigPath,
    ],
    command: 'svelte-check',
    label: `svelte-check: ${descriptor.sourceConfigPath}`,
  };
}

export function createFrameworkCheckerTarget(options: {
  descriptor: FrameworkCapabilityDescriptor;
  workspaceRootDir: string;
}): TypecheckTarget {
  const descriptor = {
    ...options.descriptor,
    packageRootDir: normalizeAbsolutePath(options.descriptor.packageRootDir),
    sourceConfigPath: normalizeAbsolutePath(
      options.descriptor.sourceConfigPath,
    ),
  };
  const workspaceRootDir = normalizeAbsolutePath(options.workspaceRootDir);
  const checkerName = frameworkCheckerName(descriptor.family);
  const portableSourceConfigPath = normalizeSlashes(
    toRelativePath(workspaceRootDir, descriptor.sourceConfigPath),
  );
  const commandTarget = createFrameworkCommandTarget(descriptor);

  return {
    ...commandTarget,
    checkerFamily: descriptor.family,
    checkerName,
    configPath: descriptor.sourceConfigPath,
    cwd: descriptor.packageRootDir,
    dependencyRequirements: frameworkRequirements[descriptor.family],
    dependencyRootDir: descriptor.packageRootDir,
    executionKind: 'typecheck',
    executionRootDir: descriptor.packageRootDir,
    id: createCheckerTargetId([
      'checker-target',
      'typecheck',
      descriptor.family,
      checkerName,
      portableSourceConfigPath,
      portableSourceConfigPath,
    ]),
    label: `${checkerName}: ${portableSourceConfigPath}`,
    sourceConfigPath: descriptor.sourceConfigPath,
    workspaceRootDir,
  };
}

export function createFrameworkCheckerTargets(options: {
  config?: ResolvedLiminaConfig;
  generatedGraph: GeneratedTsconfigGraphResult;
  workspaceRootDir: string;
}): TypecheckTarget[] {
  return collectFrameworkCapabilityDescriptors(options.generatedGraph).map(
    (descriptor) =>
      createFrameworkCheckerTarget({
        descriptor,
        workspaceRootDir: options.workspaceRootDir,
      }),
  );
}
