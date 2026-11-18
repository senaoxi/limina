import type { ResolvedLiminaInputs } from '#config/runner';
import { toRelativePath } from '#utils/path';
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
import type { CheckerDependencyFact } from './checker-ownership-types';

interface PhysicalCandidateContext {
  typeScriptSemanticContext: TypeScriptSemanticDependencyContext;
  config: ResolvedLiminaInputs;
  discovery: CheckerOwnershipDiscovery;
  importAnalysis: ImportAnalysisContext;
  project: AutoScopeProject;
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
          context.discovery.frozenProjectsByConfigPath
            .get(config.configId)
            ?.project.context.vueSemanticIdentity?.profilesByFileName.has(
              member.lexicalPath,
            ) === true,
      ),
  );
}

export function resolveSupplementalCandidate(options: {
  context: PhysicalCandidateContext;
  importRecord: CheckerDependencyFact['importRecord'];
  problems: string[];
  premises: NativeModulePremises;
  onDiscovery: (
    value: SupplementalResolution,
    coverage: NativeCoverage | undefined,
  ) => void;
}): NativeCoverage | null {
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
    extensions: [...context.project.context.extensions],
  });
  const coverage =
    discovery.state === 'resolved'
      ? candidateCoverage(context, discovery.target)
      : undefined;
  options.onDiscovery(discovery, coverage);
  // Preserve independently observed resolution and valid ownership. Missing
  // qualification cannot reopen an input obligation the compiler disproved.
  if (isInputAbsent && coverage?.state !== 'unique') return null;
  if (discovery.state !== 'resolved') {
    if (discovery.state !== 'unresolved')
      options.problems.push(
        `Pending supplemental resolution ${discovery.state}: ${options.importRecord.specifier}: ${discovery.reason}`,
      );
    return null;
  }
  const targetPath = discovery.target;
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
  if (coverage.state === 'ambiguous') {
    options.problems.push(
      formatAmbiguousPhysicalCandidate({
        config: context.config,
        importRecord: options.importRecord,
        owners: coverage.members.map((member) => member.configId),
        targetPath,
      }),
    );
    return null;
  }
  if (!isKnownFrameworkInput(context, coverage)) return null;
  if (coverage.state === 'unique') return coverage;
  if (!isInputAbsent)
    options.problems.push(
      `Pending supplemental target qualification unavailable: ${targetPath} (${coverage.state})`,
    );
  return null;
}
