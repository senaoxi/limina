import type { ResolvedLiminaInputs } from '#config/runner';
import { hasModuleSpecifierQueryOrFragment } from '#utils/module-specifier';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import type { NativeCoverage } from '../../domain/analysis/native-coverage';
import type { ImportAnalysisContext } from '../import-analysis/runner';
import {
  discoverSupplementalTarget,
  type SupplementalResolution,
} from '../import-analysis/supplemental-resolution';
import { deriveCompilerCoverage } from '../typescript-semantic/compiler-coverage';
import type { TypeScriptSemanticDependencyContext } from '../typescript-semantic/contracts';
import type { NativeModulePremises } from '../typescript-semantic/native-context-inventory';
import { observeNativeFileIdentity } from '../typescript-semantic/native-file-identity';
import { independentModuleInputAbsence } from '../typescript-semantic/native-module-impact';
import type { AutoScopeProject } from './auto-checker-types';
import type { CheckerOwnershipDiscovery } from './checker-ownership-discovery';
import type { EvidenceProject } from './checker-ownership-evidence-project';
import type {
  CheckerDependencyFact,
  PhysicalFrameworkCandidate,
  TypeConfigOwnershipState,
} from './checker-ownership-types';
import type { FileOwnerLookup } from './file-owner-lookup';
import { prepareLockedSemanticProject } from './locked-semantic-project';
import { resolveSupplementalVueTarget } from './pending-supplemental-assessment';

interface PhysicalCandidateContext {
  typeScriptSemanticContext: TypeScriptSemanticDependencyContext;
  config: ResolvedLiminaInputs;
  discovery: CheckerOwnershipDiscovery;
  importAnalysis: ImportAnalysisContext;
  membership: FileOwnerLookup;
  project: AutoScopeProject;
  semantic: EvidenceProject;
  state: TypeConfigOwnershipState;
}

function formatAmbiguousPhysicalCandidate(options: {
  config: ResolvedLiminaInputs;
  importRecord: CheckerDependencyFact['importRecord'];
  owners: readonly string[];
  targetPath: string;
}): string {
  return [
    'Pending framework target has ambiguous effective membership:',
    `  file: ${toRelativePath(options.config.rootDir, options.importRecord.filePath)}:${options.importRecord.line}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  physical target: ${toRelativePath(options.config.rootDir, options.targetPath)}`,
    '  actual owning configs:',
    ...options.owners.map(
      (owner) => `    - ${toRelativePath(options.config.rootDir, owner)}`,
    ),
    '  reason: a pending physical candidate must have exactly one effective owning tsconfig.',
  ].join('\n');
}

const FAMILY_TARGET_MATCHERS = {
  astro: (_project: AutoScopeProject, targetPath: string) =>
    targetPath.toLowerCase().endsWith('.astro'),
  svelte: (_project: AutoScopeProject, targetPath: string) =>
    targetPath.toLowerCase().endsWith('.svelte'),
  vue: (project: AutoScopeProject, targetPath: string) =>
    targetPath.toLowerCase().endsWith('.vue') ||
    project.context.vueSemanticIdentity?.profilesByFileName.has(targetPath) ===
      true,
} satisfies Record<
  PhysicalFrameworkCandidate['family'],
  (project: AutoScopeProject, targetPath: string) => boolean
>;

function isFamilyTarget(options: {
  family: PhysicalFrameworkCandidate['family'];
  project: AutoScopeProject;
  targetPath: string;
  registeredPaths: readonly string[];
}): boolean {
  return [options.targetPath, ...options.registeredPaths].some((targetPath) =>
    FAMILY_TARGET_MATCHERS[options.family](options.project, targetPath),
  );
}

function resolveUniqueOwner(options: {
  context: PhysicalCandidateContext;
  importRecord: CheckerDependencyFact['importRecord'];
  problems: string[];
  targetPath: string;
}): string | null {
  const owners = getPhysicalTargetOwners(options.context, options.targetPath);
  if (owners.length > 1) {
    options.problems.push(
      formatAmbiguousPhysicalCandidate({
        config: options.context.config,
        importRecord: options.importRecord,
        owners,
        targetPath: options.targetPath,
      }),
    );
    return null;
  }
  return owners[0] ?? null;
}

function getPhysicalTargetOwners(
  context: PhysicalCandidateContext,
  targetPath: string,
): string[] {
  const coverage = candidateCoverage(context, targetPath);
  if (coverage === undefined) return [];
  return ['unique', 'ambiguous'].includes(coverage.state)
    ? coverage.members.map((member) => member.configId)
    : [];
}

function candidateCoverage(
  context: PhysicalCandidateContext,
  targetPath: string,
) {
  const index = context.discovery.sourceConfigCoverage;
  return index === undefined
    ? undefined
    : deriveCompilerCoverage(
        index,
        observeNativeFileIdentity(targetPath, index.inputVersion),
      );
}

function getOwnerStateAndProject(options: {
  context: PhysicalCandidateContext;
  owningConfigPath: string;
}): { project: AutoScopeProject; state: TypeConfigOwnershipState } | null {
  const state = options.context.discovery.plan.typeConfigs.get(
    options.owningConfigPath,
  );
  const project = options.context.discovery.projectByConfigPath.get(
    options.owningConfigPath,
  );
  return state === undefined || project === undefined
    ? null
    : { project, state };
}

function getLockedFrameworkFamily(
  state: TypeConfigOwnershipState,
): PhysicalFrameworkCandidate['family'] | null {
  if (state.semanticAuthority.kind !== 'locked') return null;
  return state.semanticAuthority.family === 'typescript'
    ? null
    : state.semanticAuthority.family;
}

function createOwnedPhysicalCandidate(options: {
  context: PhysicalCandidateContext;
  owningConfigPath: string;
  targetPath: string;
}): PhysicalFrameworkCandidate | null {
  const owner = getOwnerStateAndProject(options);
  if (owner === null) return null;
  const family = getLockedFrameworkFamily(owner.state);
  if (family === null) return null;
  return createFamilyCandidate({
    ...options,
    family,
    project: owner.project,
    context: options.context,
    registeredPaths: options.context.membership.registeredFileNames(
      options.targetPath,
      options.owningConfigPath,
    ),
  });
}

function createFamilyCandidate(options: {
  context: PhysicalCandidateContext;
  family: PhysicalFrameworkCandidate['family'];
  owningConfigPath: string;
  project: AutoScopeProject;
  targetPath: string;
  registeredPaths: readonly string[];
}): PhysicalFrameworkCandidate | null {
  return isFamilyTarget(options) ? createProvenCandidate(options) : null;
}

function createProvenCandidate(
  options: Parameters<typeof createFamilyCandidate>[0],
): PhysicalFrameworkCandidate | null {
  const observed =
    options.context.typeScriptSemanticContext.nativeEvidence?.contexts[0];
  const coverage = candidateCoverage(options.context, options.targetPath);
  if ([observed === undefined, !isUniqueCoverage(coverage)].some(Boolean))
    return null;
  return {
    observer: 'qualified-framework-candidate-v2',
    origin: {
      source: 'framework-candidate',
      family: options.family,
      context: observed!,
    },
    coverage: coverage!,
    family: options.family,
    owningConfigPath: options.owningConfigPath,
    targetPath: options.targetPath,
  };
}

function isUniqueCoverage(
  coverage: ReturnType<typeof candidateCoverage>,
): boolean {
  return coverage?.state === 'unique';
}

function qualifyPendingPhysicalCandidate(options: {
  context: PhysicalCandidateContext;
  importRecord: CheckerDependencyFact['importRecord'];
  problems: string[];
  targetPath: string;
}): PhysicalFrameworkCandidate | null {
  const targetPath = normalizeAbsolutePath(options.targetPath);
  const owningConfigPath = resolveUniqueOwner({ ...options, targetPath });
  if (owningConfigPath === null) return null;
  return createOwnedPhysicalCandidate({
    context: options.context,
    owningConfigPath,
    targetPath,
  });
}

function canResolvePendingSpecifier(
  context: PhysicalCandidateContext,
  specifier: string,
): boolean {
  return (
    context.state.semanticAuthority.kind === 'pending' &&
    !hasModuleSpecifierQueryOrFragment(specifier)
  );
}

function isKnownFrameworkInput(
  context: PhysicalCandidateContext,
  coverage: NativeCoverage,
): boolean {
  return (
    /\.(?:vue|svelte|astro)$/.test(coverage.target.lexicalPath) ||
    hasKnownVueProfile(context, coverage)
  );
}

function hasKnownVueProfile(
  context: PhysicalCandidateContext,
  coverage: NativeCoverage,
): boolean {
  const target = coverage.target.physical;
  const index = context.discovery.sourceConfigCoverage;
  if (index === undefined || target.state !== 'verified') return false;
  // Physical identity may expose a governed custom-framework input gap. It
  // cannot grant compiler membership, select a provider or promote a Checker.
  return index.configurations.some(
    (config) =>
      config.state === 'enumerated' &&
      config.inputVersion === target.inputVersion &&
      config.members.some(
        (member) =>
          member.physical.state === 'verified' &&
          member.physical.inputVersion === target.inputVersion &&
          member.physical.canonicalId === target.canonicalId &&
          context.discovery.projectByConfigPath
            .get(config.configId)
            ?.context.vueSemanticIdentity?.profilesByFileName.has(
              member.lexicalPath,
            ) === true,
      ),
  );
}

function resolveCompilerTarget(input: {
  context: PhysicalCandidateContext;
  premises: NativeModulePremises;
  importRecord: CheckerDependencyFact['importRecord'];
  coverage: NativeCoverage;
  target: string;
}): string {
  if (!hasKnownVueProfile(input.context, input.coverage)) return input.target;
  const consumer = prepareLockedSemanticProject({
    project: input.context.project,
    authority: { kind: 'locked', family: 'vue', source: 'dependency' },
    rootDir: input.context.config.rootDir,
  }).context.vueSemanticIdentity;
  return (
    (consumer &&
      resolveSupplementalVueTarget({
        consumer,
        premises: input.premises,
        importer: input.importRecord.filePath,
        specifier: input.importRecord.specifier,
      })) ??
    input.target
  );
}

export function resolvePendingPhysicalCandidate(options: {
  context: PhysicalCandidateContext;
  importRecord: CheckerDependencyFact['importRecord'];
  problems: string[];
  premises: NativeModulePremises;
  onDiscovery: (
    value: SupplementalResolution,
    coverage: NativeCoverage | undefined,
  ) => void;
}): PhysicalFrameworkCandidate | null {
  // A query or fragment belongs to a module host. Without a checker target,
  // Limina has no authority to reinterpret it through Oxc or the filesystem.
  if (
    !canResolvePendingSpecifier(options.context, options.importRecord.specifier)
  ) {
    return null;
  }
  const { premises, context } = options;
  const isInputAbsent =
    (premises.sourceLoadGap === undefined && premises.ownAmbient) ||
    independentModuleInputAbsence({
      role: premises.role,
      options: premises.options,
      target: undefined,
      roots: [],
    })?.state === 'absent';
  const baseline =
    context.typeScriptSemanticContext.nativeEvidence?.contexts[0];
  if (baseline === undefined || premises.options === undefined) return null;
  const discovery = (
    context.importAnalysis.resolveSupplementalImport ??
    discoverSupplementalTarget
  )({
    requestId: premises.requestId,
    contextId: baseline.id,
    importer: options.importRecord.filePath,
    specifier: options.importRecord.specifier,
    mode: premises.mode,
    options: premises.options,
    configPath:
      typeof premises.options.configFilePath === 'string'
        ? premises.options.configFilePath
        : context.project.configPath,
    extensions: [...context.semantic.project.extensions],
  });
  let coverage =
    discovery.state === 'resolved'
      ? candidateCoverage(context, discovery.target)
      : undefined;
  options.onDiscovery(discovery, coverage);
  // Preserve independently observed resolution and valid ownership. Missing
  // qualification cannot reopen an input obligation the compiler disproved.
  if (isInputAbsent && !isUniqueCoverage(coverage)) return null;
  if (discovery.state !== 'resolved') {
    if (discovery.state !== 'unresolved')
      options.problems.push(
        `Pending supplemental resolution ${discovery.state}: ${options.importRecord.specifier}: ${discovery.reason}`,
      );
    return null;
  }
  const targetPath =
    !isInputAbsent && coverage !== undefined
      ? resolveCompilerTarget({
          ...options,
          coverage,
          target: discovery.target,
        })
      : discovery.target;
  if (targetPath !== discovery.target)
    coverage = candidateCoverage(context, targetPath);
  if (
    coverage === undefined ||
    coverage.completeness === 'incomplete' ||
    coverage.state === 'unavailable'
  ) {
    options.problems.push(
      `Pending supplemental coverage unavailable: ${targetPath}: ${coverage?.gaps.join(', ') ?? 'no-index'}`,
    );
    return null;
  }
  const candidate = qualifyPendingPhysicalCandidate({
    ...options,
    targetPath,
  });
  if (
    candidate === null &&
    !isInputAbsent &&
    isKnownFrameworkInput(context, coverage)
  )
    options.problems.push(
      `Pending supplemental target qualification unavailable: ${targetPath} (${coverage.state})`,
    );
  return candidate;
}
