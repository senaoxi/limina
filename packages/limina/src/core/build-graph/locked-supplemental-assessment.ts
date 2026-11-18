import { hasModuleSpecifierQueryOrFragment } from '#utils/module-specifier';
import type { NativeEvidenceSnapshot } from '../../domain/analysis/native-evidence';
import type { ImportRecord } from '../import-analysis/runner';
import { shouldInferDeclarationReferenceFromImportRecord } from '../import-graph/declaration-reference-evidence';
import { createTypeScriptDependencyContext } from '../typescript-semantic';
import { isLiveNativeInventory } from '../typescript-semantic/native-context-inventory';
import type { collectLockedProjectFacts } from './checker-ownership-locked-facts';
import { resolveSupplementalCandidate } from './checker-ownership-physical-candidate';
import type { CheckerDependencyFact } from './checker-ownership-types';
import { assessUnselectedFrameworkRequest } from './pending-supplemental-assessment';

type AssessmentInput = Parameters<typeof collectLockedProjectFacts>[0] & {
  facts: CheckerDependencyFact[];
  records: readonly ImportRecord[];
  snapshot: NativeEvidenceSnapshot;
};

/** An unresolved Native request may need an independent admission decision.
 * Its supplemental target never selects a semantic checker. */
export function assessMissingNativeImports(input: AssessmentInput): string[] {
  const ids = new Set(
    input.snapshot.resolutions
      .filter((item) => item.target === null)
      .map((item) => item.requestId),
  );
  const sites = new Set(
    input.snapshot.requests
      .filter((request) => ids.has(request.id) && request.channel === 'module')
      .map((request) =>
        JSON.stringify([request.sourceFile?.lexicalPath, request.specifier]),
      ),
  );
  const unresolved = input.records.filter(
    (record) =>
      !hasModuleSpecifierQueryOrFragment(record.specifier) &&
      shouldInferDeclarationReferenceFromImportRecord(record) &&
      sites.has(JSON.stringify([record.filePath, record.specifier])),
  );
  if (unresolved.length === 0) return [];
  const config = input.project.configPath;
  const existing = input.caches.typeScriptSemanticFactsCache
    .values()
    .find(
      (context) =>
        isLiveNativeInventory(context.nativeInventory) &&
        context.nativeEvidence?.contexts[0]?.id ===
          input.snapshot.contexts[0]?.id,
    );
  const fresh =
    existing === undefined
      ? createTypeScriptDependencyContext({
          admissionMode: 'coverage-bounded',
          analysisBinding: { phase: 'locked', checker: 'tsc' },
          compilationObligationScope: 'generated-declaration-project-v1',
          configPath: config,
          sourceConfigPath: config,
          fileNames: input.project.fileNames,
          options: input.project.options,
          projectReferences: input.project.references,
          virtualFiles: input.project.virtualFiles,
          workspaceSourceBoundary: input.workspaceSourceBoundary,
        })
      : undefined;
  const context = existing ?? fresh!;
  const problems: string[] = [];
  try {
    const byId = new Map(
      input.facts.map((fact) => [fact.nativeEvidence?.requestId, fact]),
    );
    for (const importRecord of unresolved) {
      const native = context.getDependencyFact(importRecord);
      const premises = context.nativeInventory?.modules.find(
        (item) => item.requestId === native.nativeEvidence?.requestId,
      );
      if (premises === undefined || native.resolution.target !== null) continue;
      const requestId = native.nativeEvidence?.requestId;
      if (!requestId) continue;
      let fact = byId.get(requestId);
      if (fact === undefined) {
        fact = {
          consumerConfigPath: config,
          importRecord,
          physicalTargetPath: null,
          physicalTargetProvenance: null,
          referenceRequirement: null,
          nativeEvidence: native.nativeEvidence,
          typeEvidenceKind: 'unobserved',
        };
        byId.set(requestId, fact);
        input.facts.push(fact);
      }
      const coverage = resolveSupplementalCandidate({
        context: {
          ...input,
          typeScriptSemanticContext: context,
        },
        importRecord: fact.importRecord,
        premises,
        problems,
        onDiscovery: (discovery, coverage) => {
          fact.supplementalDiscovery = discovery;
          fact.supplementalCoverage = coverage;
          if (input.caches.analysisCache)
            input.caches.analysisCache.requiresSupplementalReassessment = true;
        },
      });
      if (coverage === null) continue;
      const assessment = assessUnselectedFrameworkRequest({
        context: context.nativeEvidence!.contexts[0]!,
        premises,
        discovery: fact.supplementalDiscovery!,
        coverage,
        roots: context.nativeInventory!.roots.map((entry) => entry.root),
        emitOptions: input.project.options,
        occurrence: fact.importRecord,
      });
      fact.supplementalAssessment = assessment;
      input.caches.supplementalAssessments!.push(assessment);
    }
    return problems;
  } finally {
    fresh?.dispose();
  }
}
