import { summarizeCompilationObligation } from '../../domain/analysis/native-obligation';
import type { ProjectDependency } from '../project-dependencies/contracts';
import {
  cloneDependencyEvidence,
  createUnobservedDependencyEvidence,
} from '../project-dependencies/evidence';
import { createSourceProjectSemanticContext } from '../project-dependencies/runner';
import { createImportRecordIdentity } from '../typescript-semantic/import-record';
import { observeNativeFileIdentity } from '../typescript-semantic/native-file-identity';
import { isCurrentLockedSupplement } from './pending-supplemental-assessment';
import type { ReferenceImportContext } from './reference-import-types';
import type { GovernedSourceUnit, SourceProject } from './types';

/** Supplies the existing reference consumer with qualified inputs.
 * The evidence is an audited supplement, never a fabricated Native fact. */
export function collectSupplementalReferenceInputs(input: {
  dependencies: readonly ProjectDependency[];
  context: ReferenceImportContext;
  project: SourceProject;
  source?: GovernedSourceUnit;
}): ProjectDependency[] {
  const dependencies: ProjectDependency[] = [];
  const assessments =
    input.context.projectDependencyCaches.supplementalAssessments ?? [];
  const request = {
    context: createSourceProjectSemanticContext({
      authority: input.project.semanticAuthority,
      project: input.project,
      source: input.source,
      workspaceSourceBoundary: input.context.workspaceSourceBoundary,
    }),
    importAnalysis: input.context.importAnalysis,
  };
  for (const assessment of assessments) {
    if (
      !isCurrentLockedSupplement(assessment) ||
      assessment.obligation.consumerConfigId !== input.project.configPath ||
      summarizeCompilationObligation(assessment.obligation) !== 'required' ||
      assessment.discovery.state !== 'resolved'
    )
      continue;
    const record = assessment.occurrence;
    const targetIdentity = assessment.coverage.target.physical;
    if (
      input.dependencies.some((dependency) => {
        if (
          dependency.referenceRequirement === null ||
          createImportRecordIdentity({
            ...dependency.importRecord,
            compilerRequest: undefined,
          }) !==
            createImportRecordIdentity({
              ...record,
              compilerRequest: undefined,
            })
        )
          return false;
        const actual = observeNativeFileIdentity(
          dependency.resolvedFilePath,
          assessment.coverage.inputVersion,
        ).physical;
        return (
          actual.state === 'verified' &&
          targetIdentity.state === 'verified' &&
          actual.canonicalId === targetIdentity.canonicalId
        );
      })
    )
      continue;
    const target = assessment.discovery.target;
    dependencies.push({
      supplementalAssessment: assessment,
      evidence: cloneDependencyEvidence({
        ...createUnobservedDependencyEvidence(request),
        occurrence: record,
        checker: { kind: 'supplemental', assessment },
      }),
      importRecord: record,
      provenance: 'qualified-supplement',
      referenceRequirement: {
        kind: 'compiler-membership',
        targetFileName: target,
      },
      resolutionMode: String(assessment.premises.mode ?? 'default'),
      resolvedFilePath: target,
      semanticSpecifier: record.specifier,
      targetKind: 'source',
    });
  }
  return dependencies;
}
