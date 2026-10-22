import type { NativeEvidenceSnapshot } from '../../domain/analysis/native-evidence';
import type { NativeCompilationObligation } from '../../domain/analysis/native-obligation';
import type { CandidateBuildPlan } from './analysis-admission';
import {
  projectCompilationPrerequisite,
  type ProjectedCompilationPrerequisite,
} from './compilation-prerequisite';
import {
  type CompilationReferenceIdentity,
  projectionConsumers,
  projections,
} from './compilation-projection';
import { selectProviderIdentity } from './provider-selection';
import type { GovernedSourceUnit } from './types';

interface ProviderInput {
  sources: readonly GovernedSourceUnit[];
  target: string;
  files: readonly string[];
}
function providerIdentity(unit: GovernedSourceUnit) {
  return {
    checkerName: unit.primaryCheckerName,
    context: unit.context,
    ownedFileNames: unit.ownedFileNames,
    unit,
  };
}
export function projectedProvider(
  source: GovernedSourceUnit,
  input: ProviderInput,
): GovernedSourceUnit | undefined {
  const candidates = input.sources.filter(
    (unit) =>
      unit.configPath === input.target &&
      'dtsConfigPath' in unit.buildProjection,
  );
  const local = candidates.find(
    (unit) => unit.primaryCheckerName === source.primaryCheckerName,
  );
  if (local !== undefined) return local;
  const selected = selectProviderIdentity({
    consumerProject: providerIdentity(source),
    providerSourceFilePaths: input.files,
    targetProjects: candidates.map(providerIdentity),
  });
  return selected.kind === 'selected' ? selected.project.unit : undefined;
}
interface ReferenceBinding {
  source: GovernedSourceUnit;
  provider: GovernedSourceUnit;
  from: string;
  to: string;
}
function hasMatchingReference(
  reference: CompilationReferenceIdentity,
  binding: ReferenceBinding,
): boolean {
  return [
    ['declaration', 'output'].includes(reference.kind),
    reference.from.checkerName === binding.source.primaryCheckerName,
    reference.to.checkerName === binding.provider.primaryCheckerName,
    reference.from.sourceConfigPath === binding.source.configPath,
    reference.to.sourceConfigPath === binding.provider.configPath,
    reference.kind === 'output' ||
      (reference.fromConfigPath === binding.from &&
        reference.toConfigPath === binding.to),
  ].every(Boolean);
}
function hasDeclarationReference(
  candidate: CandidateBuildPlan,
  source: GovernedSourceUnit,
  prerequisite: ProjectedCompilationPrerequisite,
): boolean {
  const projection = projections.get(candidate)!;
  const provider = projectedProvider(source, {
    sources: projection.sources,
    target: prerequisite.obligation.targetConfigId!,
    files: prerequisite.targetIdentities.map((target) => target.lexicalPath),
  });
  return (
    provider !== undefined && hasBoundReference(candidate, { source, provider })
  );
}
function hasBoundReference(
  candidate: CandidateBuildPlan,
  pair: Pick<ReferenceBinding, 'source' | 'provider'>,
): boolean {
  if (!hasDeclarationProjections(pair)) return false;
  const binding = {
    ...pair,
    from: declarationPath(pair.source),
    to: declarationPath(pair.provider),
  };
  const references = projections.get(candidate)!.references;
  return references === undefined
    ? pair.source.declarationReferences.has(binding.to)
    : references.some((reference) => hasMatchingReference(reference, binding));
}
export function hasProjectedCompilationReference(
  snapshot: NativeEvidenceSnapshot,
  obligation: NativeCompilationObligation,
  candidate: CandidateBuildPlan,
): boolean {
  const prerequisite = projectCompilationPrerequisite(
    snapshot,
    obligation,
    candidate,
  );
  if (prerequisite === undefined) return false;
  if (prerequisite.requiredRelation === 'framework-schedule') return true;
  const sources = projectionConsumers(candidate, obligation.consumerConfigId);
  return [
    sources.length > 0,
    sources.every((source) =>
      hasDeclarationReference(candidate, source, prerequisite),
    ),
  ].every(Boolean);
}

function declarationPath(source: GovernedSourceUnit): string {
  return 'dtsConfigPath' in source.buildProjection
    ? source.buildProjection.dtsConfigPath
    : '';
}
function hasDeclarationProjections(
  pair: Pick<ReferenceBinding, 'source' | 'provider'>,
): boolean {
  return [
    'dtsConfigPath' in pair.source.buildProjection,
    'dtsConfigPath' in pair.provider.buildProjection,
  ].every(Boolean);
}
