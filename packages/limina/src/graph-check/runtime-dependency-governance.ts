import type { ImportRecord, ProjectInfo } from '#core/import-graph/context';
import type { ProjectDependencyCollection } from '../core/project-dependencies/contracts';
import { addDeniedDependencyImportProblem } from './import-access-denied';
import type { ExpectedReferenceCollectionContext } from './reference-types';
import {
  getDeniedDepRuleForSpecifier as getDeniedDependencyRuleForSpecifier,
  type GraphRuleDependencyDeny,
} from './rules';
import {
  getDeniedDependencyRuleForResolvedPackage,
  isAddWorkspaceConsumptionProblem,
} from './workspace-import-findings';

interface RuntimePolicyInput {
  context: ExpectedReferenceCollectionContext;
  project: ProjectInfo;
  importRecord: ImportRecord;
}

function isRecordDeniedRule(
  input: RuntimePolicyInput,
  rule: GraphRuleDependencyDeny | null | undefined,
): boolean {
  if (rule == null) return false;
  addDeniedDependencyImportProblem({
    ...input,
    config: input.context.config,
    findings: input.context.findings,
    projectCheckerNamesByPath: input.context.projectCheckerNamesByPath,
    rule,
  });
  return true;
}

function isRecordRawDeniedRule(input: RuntimePolicyInput): boolean {
  return isRecordDeniedRule(
    input,
    getDeniedDependencyRuleForSpecifier(
      input.context.graphRules,
      input.project.labels,
      input.importRecord.specifier,
    ),
  );
}

/**
 * Governance consumes source/runtime facts without creating reference edges.
 */
export function recordRuntimeDependencyGovernance(
  context: ExpectedReferenceCollectionContext,
  project: ProjectInfo,
  collection: ProjectDependencyCollection,
): void {
  for (const dependency of collection.dependencies)
    recordDependencyGovernance(context, project, dependency);
  for (const observation of collection.observations)
    recordObservationGovernance(context, project, observation);
}

function recordObservationGovernance(
  context: ExpectedReferenceCollectionContext,
  project: ProjectInfo,
  observation: ProjectDependencyCollection['observations'][number],
): void {
  if (observation.kind === 'unmapped-generated') return;
  const input = { context, project, importRecord: observation.importRecord };
  if (!isRecordRawDeniedRule(input))
    isAddWorkspaceConsumptionProblem({
      context,
      project,
      consumption: observation,
    });
}

function recordDependencyGovernance(
  context: ExpectedReferenceCollectionContext,
  project: ProjectInfo,
  dependency: ProjectDependencyCollection['dependencies'][number],
): void {
  const input = { context, project, importRecord: dependency.importRecord };
  if (isRecordRawDeniedRule(input)) return;
  isAddWorkspaceConsumptionProblem({
    context,
    project,
    consumption: dependency,
  });
  isRecordDeniedRule(
    input,
    getDeniedDependencyRuleForResolvedPackage({
      context,
      project,
      resolvedFilePath: dependency.resolvedFilePath,
    }),
  );
}
