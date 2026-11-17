import type { CheckerName, ResolvedLiminaInputs } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { hasModuleSpecifierQueryOrFragment } from '#utils/module-specifier';
import { toRelativePath } from '#utils/path';
import type { AutoScopeProject } from './auto-checker-types';
import type {
  CheckerDependencyFact,
  CheckerEvidence,
} from './checker-ownership-types';
import { FileOwnerLookup } from './file-owner-lookup';

interface RequirementResolution {
  evidence?: { checker: CheckerName; value: CheckerEvidence };
  problem?: string;
}

export function createActualMembershipIndex(
  projects: ReadonlyMap<string, AutoScopeProject>,
): FileOwnerLookup {
  return new FileOwnerLookup(projects.values());
}

export function frameworkCheckerForTarget(
  target: string,
  project?: AutoScopeProject,
): CheckerName | undefined {
  if (target.endsWith('.astro')) return 'astro';
  if (target.endsWith('.svelte')) return 'svelte-check';
  return target.endsWith('.vue') ||
    project?.filePartition.vueFiles.includes(target)
    ? 'vue-tsc'
    : undefined;
}

function resolveRequirement(options: {
  config: ResolvedLiminaInputs;
  fact: CheckerDependencyFact;
  membership: FileOwnerLookup;
  projects: ReadonlyMap<string, AutoScopeProject>;
}): RequirementResolution {
  const candidate = options.fact.frameworkCandidate;
  const discovery = options.fact.supplementalDiscovery;
  if (hasModuleSpecifierQueryOrFragment(options.fact.importRecord.specifier))
    return {};
  const target =
    discovery?.state === 'resolved'
      ? discovery.target
      : options.fact.physicalTargetProvenance ===
            'pending-framework-candidate' ||
          options.fact.physicalTargetProvenance === 'checker-source'
        ? options.fact.physicalTargetPath
        : undefined;
  if (target == null) return {};
  const owner = options.membership
    .get(target)
    ?.map((configPath) => options.projects.get(configPath))
    .find((project) => project?.filePartition.vueFiles.includes(target));
  const checker =
    frameworkCheckerForTarget(target, owner) ??
    (candidate?.family === 'vue' ? 'vue-tsc' : undefined);
  if (checker === undefined) return {};
  // This is the consumer's observed request feature, not the provider's owner.
  return {
    evidence: {
      checker,
      value: {
        checker,
        configPath: options.fact.consumerConfigPath,
        source: 'dependency',
        detail: `${toRelativePath(options.config.rootDir, options.fact.importRecord.filePath)}:${options.fact.importRecord.line} imports ${options.fact.importRecord.specifier}; discovered framework target ${toRelativePath(options.config.rootDir, target)}`,
      },
    },
  };
}

function appendRequirementResolution(options: {
  evidence: Map<CheckerName, CheckerEvidence>;
  problems: string[];
  resolution: RequirementResolution;
}): void {
  appendRequirementProblem(options.problems, options.resolution.problem);
  appendRequirementEvidence(options.evidence, options.resolution.evidence);
}

function appendRequirementProblem(
  problems: string[],
  problem: string | undefined,
): void {
  if (problem !== undefined) problems.push(problem);
}

function appendRequirementEvidence(
  evidence: Map<CheckerName, CheckerEvidence>,
  resolved: RequirementResolution['evidence'],
): void {
  if (resolved === undefined) return;
  const current = evidence.get(resolved.checker);
  if (
    current === undefined ||
    compareCodeUnits(resolved.value.detail, current.detail) < 0
  ) {
    evidence.set(resolved.checker, resolved.value);
  }
}

export function collectRequirementsForConsumer(options: {
  config: ResolvedLiminaInputs;
  facts: readonly CheckerDependencyFact[];
  membership: FileOwnerLookup;
  projects: ReadonlyMap<string, AutoScopeProject>;
}): { evidence: Map<CheckerName, CheckerEvidence>; problems: string[] } {
  const evidence = new Map<CheckerName, CheckerEvidence>();
  const problems: string[] = [];
  for (const fact of options.facts) {
    appendRequirementResolution({
      evidence,
      problems,
      resolution: resolveRequirement({ ...options, fact }),
    });
  }
  return { evidence, problems };
}
