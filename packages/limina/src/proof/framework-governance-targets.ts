import type { ResolvedLiminaConfig } from '#config/runner';
import type {
  FrameworkCapabilityDescriptor,
  GeneratedTsconfigGraphResult,
} from '#core/build-graph/runner';
import { toRelativePath } from '#utils/path';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import { collectFrameworkTargetPreflightFailures } from '../typecheck/framework-target-preflight';
import {
  collectFrameworkCapabilityDescriptors,
  createFrameworkCheckerTargets,
  type TypecheckTarget,
} from '../typecheck/targets';
import type { ProofFinding } from './findings';
import { addFrameworkGovernanceFinding } from './framework-governance-common';
import type {
  FrameworkFamily,
  FrameworkGovernanceFactForKind,
} from './framework-governance-types';

interface TargetOptions {
  config: ResolvedLiminaConfig;
  findings: ProofFinding[];
  generatedGraph: GeneratedTsconfigGraphResult;
  workspaceLookup: WorkspaceLookupIndex;
}

const frameworkCommands = {
  astro: 'astro',
  svelte: 'svelte-check',
} satisfies Record<FrameworkFamily, string>;

const targetReasons = {
  'duplicate-id':
    'each framework-owned config must produce one stable, non-mutating checker target rooted at its leaf package.',
  'invalid-shape':
    'each framework-owned config must produce one stable, non-mutating checker target rooted at its leaf package.',
  missing:
    'each framework-owned config must produce one stable, non-mutating checker target rooted at its leaf package.',
  'preflight-failed':
    'framework targets must resolve their checker binary, runtime peers, and generated types from the leaf package before proof can accept them as executable.',
} satisfies Record<
  FrameworkGovernanceFactForKind<'framework-target'>['violation'],
  string
>;

function descriptorIdentity(
  descriptor: Pick<
    FrameworkCapabilityDescriptor,
    'family' | 'sourceConfigPath'
  >,
): string {
  return `${descriptor.family}\0${descriptor.sourceConfigPath}`;
}

function targetIdentity(target: TypecheckTarget): string | undefined {
  const values = [target.checkerFamily, target.sourceConfigPath];
  return values.every((value) => value !== undefined)
    ? `${values[0]}\0${values[1]}`
    : undefined;
}

function addTargetFinding(options: {
  config: ResolvedLiminaConfig;
  descriptor: FrameworkCapabilityDescriptor;
  findings: ProofFinding[];
  problems: readonly string[];
  targetIds: readonly string[];
  violation: FrameworkGovernanceFactForKind<'framework-target'>['violation'];
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const reason = targetReasons[options.violation];
  addFrameworkGovernanceFinding({
    config: options.config,
    configPath: options.descriptor.sourceConfigPath,
    detailLines: [
      'Framework checker target is not executable:',
      `  config: ${toRelativePath(options.config.rootDir, options.descriptor.sourceConfigPath)}`,
      `  family: ${options.descriptor.family}`,
      `  violation: ${options.violation}`,
      ...options.problems.flatMap((problem) =>
        problem.split('\n').map((line) => `  ${line}`),
      ),
      `  reason: ${reason}`,
    ],
    facts: {
      configPath: options.descriptor.sourceConfigPath,
      family: options.descriptor.family,
      kind: 'framework-target',
      problems: options.problems,
      targetIds: options.targetIds,
      violation: options.violation,
    },
    findings: options.findings,
    reason,
    title: 'Framework checker target is not executable',
    workspaceLookup: options.workspaceLookup,
  });
}

function targetHasExpectedShape(
  target: TypecheckTarget,
  descriptor: FrameworkCapabilityDescriptor,
): boolean {
  const forbiddenArgs = new Set([
    '--incremental',
    '--output',
    '--preserveWatchOutput',
  ]);
  const astroSyncPolicy = {
    astro: target.args.includes('--noSync'),
    svelte: true,
  } satisfies Record<FrameworkFamily, boolean>;
  return [
    target.checkerFamily === descriptor.family,
    target.command === frameworkCommands[descriptor.family],
    target.configPath === descriptor.sourceConfigPath,
    target.cwd === descriptor.packageRootDir,
    target.dependencyRootDir === descriptor.packageRootDir,
    target.executionKind === 'typecheck',
    target.sourceConfigPath === descriptor.sourceConfigPath,
    target.args.every((argument) => !forbiddenArgs.has(argument)),
    astroSyncPolicy[descriptor.family],
  ].every(Boolean);
}

function indexTargetsByDescriptor(
  targets: readonly TypecheckTarget[],
): Map<string, TypecheckTarget> {
  const index = new Map<string, TypecheckTarget>();
  for (const target of targets) {
    const identity = targetIdentity(target);
    if (identity !== undefined) index.set(identity, target);
  }
  return index;
}

function addMissingOrInvalidTarget(options: {
  descriptor: FrameworkCapabilityDescriptor;
  target: TypecheckTarget | undefined;
  targetOptions: TargetOptions;
}): boolean {
  if (options.target === undefined) {
    addTargetFinding({
      ...options.targetOptions,
      descriptor: options.descriptor,
      problems: [],
      targetIds: [],
      violation: 'missing',
    });
    return true;
  }
  if (targetHasExpectedShape(options.target, options.descriptor)) return false;
  addTargetFinding({
    ...options.targetOptions,
    descriptor: options.descriptor,
    problems: [],
    targetIds: [options.target.id],
    violation: 'invalid-shape',
  });
  return false;
}

function addTargetPreflightFindings(options: {
  descriptor: FrameworkCapabilityDescriptor;
  target: TypecheckTarget;
  targetOptions: TargetOptions;
}): void {
  const failures = collectFrameworkTargetPreflightFailures({
    targets: [options.target],
    workspaceRootDir: options.targetOptions.config.rootDir,
  });
  for (const failure of failures) {
    addTargetFinding({
      ...options.targetOptions,
      descriptor: options.descriptor,
      problems: failure.problems,
      targetIds: [options.target.id],
      violation: 'preflight-failed',
    });
  }
}

function indexTargetsById(
  targets: readonly TypecheckTarget[],
): Map<string, TypecheckTarget[]> {
  const targetById = new Map<string, TypecheckTarget[]>();
  for (const target of targets) {
    targetById.set(target.id, [...(targetById.get(target.id) ?? []), target]);
  }
  return targetById;
}

function addDuplicateTargetIdGroup(options: {
  descriptors: readonly FrameworkCapabilityDescriptor[];
  duplicates: readonly TypecheckTarget[];
  targetOptions: TargetOptions;
}): void {
  if (options.duplicates.length < 2) return;
  const identity = targetIdentity(options.duplicates[0]!);
  const descriptor = options.descriptors.find(
    (candidate) => descriptorIdentity(candidate) === identity,
  );
  if (descriptor === undefined) return;
  addTargetFinding({
    ...options.targetOptions,
    descriptor,
    problems: [],
    targetIds: options.duplicates.map((target) => target.id),
    violation: 'duplicate-id',
  });
}

function addDuplicateTargetIdFindings(
  options: TargetOptions,
  descriptors: readonly FrameworkCapabilityDescriptor[],
  targets: readonly TypecheckTarget[],
): void {
  for (const duplicates of indexTargetsById(targets).values()) {
    addDuplicateTargetIdGroup({
      descriptors,
      duplicates,
      targetOptions: options,
    });
  }
}

function addDescriptorTargetFindings(
  options: TargetOptions,
  descriptors: readonly FrameworkCapabilityDescriptor[],
  targetsByDescriptor: ReadonlyMap<string, TypecheckTarget>,
): void {
  for (const descriptor of descriptors) {
    const target = targetsByDescriptor.get(descriptorIdentity(descriptor));
    if (
      addMissingOrInvalidTarget({ descriptor, target, targetOptions: options })
    ) {
      continue;
    }
    addTargetPreflightFindings({
      descriptor,
      target: target!,
      targetOptions: options,
    });
  }
}

export function addFrameworkTargetFindings(options: TargetOptions): void {
  const descriptors = collectFrameworkCapabilityDescriptors(
    options.generatedGraph,
  );
  const targets = createFrameworkCheckerTargets({
    generatedGraph: options.generatedGraph,
    workspaceRootDir: options.config.rootDir,
  });
  addDuplicateTargetIdFindings(options, descriptors, targets);
  addDescriptorTargetFindings(
    options,
    descriptors,
    indexTargetsByDescriptor(targets),
  );
}
