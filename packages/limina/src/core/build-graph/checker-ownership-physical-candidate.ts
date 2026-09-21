import type { ResolvedLiminaConfig } from '#config/runner';
import { hasModuleSpecifierQueryOrFragment } from '#utils/module-specifier';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import type { ImportAnalysisContext } from '../import-analysis/runner';
import type { AutoScopeProject } from './auto-checker-types';
import type { CheckerOwnershipDiscovery } from './checker-ownership-discovery';
import type { EvidenceProject } from './checker-ownership-evidence-project';
import type {
  CheckerDependencyFact,
  PhysicalFrameworkCandidate,
  TypeConfigOwnershipState,
} from './checker-ownership-types';
import type { FileOwnerLookup } from './file-owner-lookup';

interface PhysicalCandidateContext {
  config: ResolvedLiminaConfig;
  discovery: CheckerOwnershipDiscovery;
  importAnalysis: ImportAnalysisContext;
  membership: FileOwnerLookup;
  project: AutoScopeProject;
  semantic: EvidenceProject;
  state: TypeConfigOwnershipState;
}

function formatAmbiguousPhysicalCandidate(options: {
  config: ResolvedLiminaConfig;
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
  const owners = getPhysicalTargetOwners(
    options.context.membership,
    options.targetPath,
  );
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
  membership: FileOwnerLookup,
  targetPath: string,
): string[] {
  return membership.get(targetPath) ?? [];
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
  if (state === undefined || project === undefined) return null;
  return { project, state };
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
    registeredPaths: options.context.membership.registeredFileNames(
      options.targetPath,
      options.owningConfigPath,
    ),
  });
}

function createFamilyCandidate(options: {
  family: PhysicalFrameworkCandidate['family'];
  owningConfigPath: string;
  project: AutoScopeProject;
  targetPath: string;
  registeredPaths: readonly string[];
}): PhysicalFrameworkCandidate | null {
  if (!isFamilyTarget(options)) {
    return null;
  }
  return {
    family: options.family,
    owningConfigPath: options.owningConfigPath,
    targetPath: options.targetPath,
  };
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

export function resolvePendingPhysicalCandidate(options: {
  context: PhysicalCandidateContext;
  importRecord: CheckerDependencyFact['importRecord'];
  problems: string[];
}): PhysicalFrameworkCandidate | null {
  // A query or fragment belongs to a module host. Without a checker target,
  // Limina has no authority to reinterpret it through Oxc or the filesystem.
  if (
    !canResolvePendingSpecifier(options.context, options.importRecord.specifier)
  ) {
    return null;
  }
  const targetPath = options.context.importAnalysis.resolveOxcImport(
    options.importRecord.specifier,
    options.importRecord.filePath,
    options.context.semantic.project.options,
    options.context.semantic.project,
  );
  if (targetPath === null) return null;
  return qualifyPendingPhysicalCandidate({ ...options, targetPath });
}
