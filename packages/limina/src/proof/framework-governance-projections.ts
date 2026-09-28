import { isBuildCapablePreset } from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import { uniqueCodeUnitSortedStrings } from '#utils/collections';
import { toRelativePath } from '#utils/path';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import { readProofConfig } from './config-reader';
import type { ProofFinding } from './findings';
import {
  addFrameworkGovernanceFinding,
  collectUnsupportedFrameworkEntries,
  getExpectedBuildProjectionKind,
} from './framework-governance-common';
import type {
  FrameworkGovernanceFactForKind,
  GovernedSourceEntry,
} from './framework-governance-types';

interface ProjectionOptions {
  config: ResolvedLiminaConfig;
  entries: readonly GovernedSourceEntry[];
  findings: ProofFinding[];
  generatedGraph: GeneratedTsconfigGraphResult;
  workspaceLookup: WorkspaceLookupIndex;
}

type ProjectionViolation =
  FrameworkGovernanceFactForKind<'build-projection'>['violation'];

interface ProjectionContext {
  entry: GovernedSourceEntry;
  generatedGraph: GeneratedTsconfigGraphResult;
}

function violationWhen(
  condition: boolean,
  violation: ProjectionViolation,
): ProjectionViolation | undefined {
  return condition ? violation : undefined;
}

function getSourceToBuild(context: ProjectionContext) {
  return context.generatedGraph.sourceToBuild
    .get(context.entry.checkerName)
    ?.get(context.entry.unit.configPath);
}

function getSourceToDts(context: ProjectionContext): string | undefined {
  return context.generatedGraph.sourceToDts
    .get(context.entry.checkerName)
    ?.get(context.entry.unit.configPath);
}

function validateDeclarationProject(
  context: ProjectionContext,
): ProjectionViolation | undefined {
  const projection = context.entry.unit.buildProjection;
  const invalid = [
    getSourceToBuild(context)?.kind !== 'project',
    getSourceToDts(context) !==
      ('dtsConfigPath' in projection ? projection.dtsConfigPath : undefined),
  ].some(Boolean);
  return violationWhen(invalid, 'declaration-provider-mismatch');
}

function validateTransparentSolution(
  context: ProjectionContext,
): ProjectionViolation | undefined {
  const wrongKind = violationWhen(
    getSourceToBuild(context)?.kind !== 'solution',
    'solution-kind-mismatch',
  );
  const wrongProvider = violationWhen(
    [
      getSourceToDts(context) !== undefined,
      context.entry.unit.declarationFileNames.length > 0,
    ].some(Boolean),
    'declaration-provider-mismatch',
  );
  return [wrongKind, wrongProvider].find(
    (violation) => violation !== undefined,
  );
}

function validateWrappedProject(
  context: ProjectionContext,
): ProjectionViolation | undefined {
  const projection = context.entry.unit.buildProjection;
  const wrongKind = violationWhen(
    getSourceToBuild(context)?.kind !== 'solution',
    'solution-kind-mismatch',
  );
  const wrongProvider = violationWhen(
    getSourceToDts(context) !==
      ('dtsConfigPath' in projection ? projection.dtsConfigPath : undefined),
    'declaration-provider-mismatch',
  );
  return [wrongKind, wrongProvider].find(
    (violation) => violation !== undefined,
  );
}

function validateFrameworkChecker(
  context: ProjectionContext,
): ProjectionViolation | undefined {
  const invalid = [
    getSourceToBuild(context) !== undefined,
    getSourceToDts(context) !== undefined,
    context.entry.unit.declarationFileNames.length > 0,
  ].some(Boolean);
  return violationWhen(invalid, 'declaration-provider-mismatch');
}

const projectionValidators = {
  'declaration-project': validateDeclarationProject,
  'framework-checker': validateFrameworkChecker,
  'transparent-solution': validateTransparentSolution,
  'wrapped-project': validateWrappedProject,
} as const;

function hasFrameworkDeclarationSource(entry: GovernedSourceEntry): boolean {
  return entry.unit.declarationFileNames.some((fileName) =>
    ['.astro', '.svelte'].some((extension) => fileName.endsWith(extension)),
  );
}

function findProjectionViolation(
  context: ProjectionContext,
): ProjectionViolation | undefined {
  const frameworkViolation = violationWhen(
    hasFrameworkDeclarationSource(context.entry),
    'framework-source-in-declaration',
  );
  const kindViolation = violationWhen(
    context.entry.unit.buildProjection.kind !==
      getExpectedBuildProjectionKind(context.entry),
    'solution-kind-mismatch',
  );
  const projectionViolation =
    projectionValidators[context.entry.unit.buildProjection.kind](context);
  return [frameworkViolation, kindViolation, projectionViolation].find(
    (violation) => violation !== undefined,
  );
}

function addProjectionFinding(
  options: ProjectionOptions,
  entry: GovernedSourceEntry,
  violation: ProjectionViolation,
): void {
  const projection = entry.unit.buildProjection.kind;
  const reason =
    'declaration projects provide consumable declarations; framework checker leaves provide semantic typecheck targets without declaration projections.';
  addFrameworkGovernanceFinding({
    checkerName: entry.checkerName,
    config: options.config,
    configPath: entry.unit.configPath,
    detailLines: [
      'Generated build projection mixes declaration-provider and solution semantics:',
      `  checker: ${entry.checkerName}`,
      `  config: ${toRelativePath(options.config.rootDir, entry.unit.configPath)}`,
      `  projection: ${projection}`,
      `  violation: ${violation}`,
      `  reason: ${reason}`,
    ],
    facts: {
      configPath: entry.unit.configPath,
      kind: 'build-projection',
      projection,
      violation,
    },
    findings: options.findings,
    reason,
    title:
      'Generated build projection mixes declaration-provider and solution semantics',
    workspaceLookup: options.workspaceLookup,
  });
}

function addBuildProjectionEntryFinding(
  options: ProjectionOptions,
  entry: GovernedSourceEntry,
): void {
  const violation = findProjectionViolation({
    entry,
    generatedGraph: options.generatedGraph,
  });
  if (violation !== undefined) addProjectionFinding(options, entry, violation);
}

function addBuildProjectionFindings(options: ProjectionOptions): void {
  for (const entry of options.entries) {
    addBuildProjectionEntryFinding(options, entry);
  }
}

function getBuildCheckerNames(
  generatedGraph: GeneratedTsconfigGraphResult,
): Set<string> {
  return new Set(
    generatedGraph.checkers
      .filter((checker) => isBuildCapablePreset(checker.name))
      .map((checker) => checker.name),
  );
}

function collectGeneratedBuildConfigPaths(
  generatedGraph: GeneratedTsconfigGraphResult,
): string[] {
  const buildCheckerNames = getBuildCheckerNames(generatedGraph);
  const buildPaths = [...generatedGraph.sourceToBuild.entries()].flatMap(
    ([checkerName, modules]) =>
      buildCheckerNames.has(checkerName)
        ? [...modules.values()].map((module) => module.path)
        : [],
  );
  const declarationPaths = [...generatedGraph.sourceToDts.entries()].flatMap(
    ([checkerName, sourceToDts]) =>
      buildCheckerNames.has(checkerName) ? [...sourceToDts.values()] : [],
  );
  return uniqueCodeUnitSortedStrings([...buildPaths, ...declarationPaths]);
}

function findSourceConfigPath(
  generatedGraph: GeneratedTsconfigGraphResult,
  generatedConfigPath: string,
): string {
  const buildSource = [...generatedGraph.sourceToBuild.values()]
    .flatMap((modules) => [...modules.entries()])
    .find(([, module]) => module.path === generatedConfigPath)?.[0];
  const declarationSource = [...generatedGraph.dtsToSource.values()]
    .flatMap((dtsToSource) => [...dtsToSource.entries()])
    .find(([dtsPath]) => dtsPath === generatedConfigPath)?.[1];
  return [buildSource, declarationSource, generatedConfigPath].find(
    (candidate): candidate is string => candidate !== undefined,
  )!;
}

function addGeneratedExtensionFinding(options: {
  config: ResolvedLiminaConfig;
  findings: ProofFinding[];
  generatedConfigPath: string;
  sourceConfigPath: string;
  unsupportedEntries: readonly string[];
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const reason =
    'tsc, tsgo, and vue-tsc build configs must contain only extensions their build engine supports; Astro and Svelte sources remain in their framework-owned configs.';
  addFrameworkGovernanceFinding({
    config: options.config,
    configPath: options.sourceConfigPath,
    detailLines: [
      'Generated build config contains unsupported framework sources:',
      `  source config: ${toRelativePath(options.config.rootDir, options.sourceConfigPath)}`,
      `  generated config: ${toRelativePath(options.config.rootDir, options.generatedConfigPath)}`,
      `  unsupported entries: ${options.unsupportedEntries.join(', ')}`,
      `  reason: ${reason}`,
    ],
    facts: {
      configPath: options.sourceConfigPath,
      generatedConfigPath: options.generatedConfigPath,
      kind: 'generated-build-extension',
      unsupportedEntries: options.unsupportedEntries,
    },
    findings: options.findings,
    reason,
    title: 'Generated build config contains unsupported framework sources',
    workspaceLookup: options.workspaceLookup,
  });
}

function addGeneratedBuildExtensionFindings(options: ProjectionOptions): void {
  const configPaths = collectGeneratedBuildConfigPaths(options.generatedGraph);
  for (const generatedConfigPath of configPaths) {
    const configObject = readProofConfig(
      options.config,
      generatedConfigPath,
      options.generatedGraph.generatedFiles,
    );
    const unsupportedEntries = collectUnsupportedFrameworkEntries(configObject);
    if (unsupportedEntries.length === 0) continue;
    addGeneratedExtensionFinding({
      ...options,
      generatedConfigPath,
      sourceConfigPath: findSourceConfigPath(
        options.generatedGraph,
        generatedConfigPath,
      ),
      unsupportedEntries,
    });
  }
}

export function addFrameworkProjectionFindings(
  options: ProjectionOptions,
): void {
  addBuildProjectionFindings(options);
  addGeneratedBuildExtensionFindings(options);
}
