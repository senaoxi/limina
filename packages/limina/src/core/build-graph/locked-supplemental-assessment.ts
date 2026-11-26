import { hasModuleSpecifierQueryOrFragment } from '#utils/module-specifier';
import type { NativeEvidenceSnapshot } from '../../domain/analysis/native-evidence';
import { hasQualifiedNativeContext } from '../analysis-cache/restored-context';
import { shouldInferDeclarationReferenceFromImportRecord } from '../import-graph/declaration-reference-evidence';
import type { ReferenceGraphFacts } from '../project-dependencies/reference-facts';
import type { TypeScriptSemanticDependencyContext } from '../typescript-semantic';
import type { collectLockedProjectFacts } from './checker-ownership-locked-facts';
import { resolveSupplementalCandidate } from './checker-ownership-physical-candidate';
import type { CheckerDependencyFact } from './checker-ownership-types';
import { assessUnselectedFrameworkRequest } from './pending-supplemental-assessment';

type AssessmentInput = Parameters<typeof collectLockedProjectFacts>[0] & {
  facts: CheckerDependencyFact[];
  records: ReferenceGraphFacts['unresolvedNativeRecords'];
  snapshot: NativeEvidenceSnapshot;
};

function missingNativeEvidence(
  context: TypeScriptSemanticDependencyContext,
  record: AssessmentInput['records'][number]['record'],
) {
  const fact = context.getDependencyFact(record);
  return fact.resolution.target === null ? fact.nativeEvidence : undefined;
}

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
    ({ record }) =>
      !hasModuleSpecifierQueryOrFragment(record.specifier) &&
      shouldInferDeclarationReferenceFromImportRecord(record) &&
      sites.has(JSON.stringify([record.filePath, record.specifier])),
  );
  if (unresolved.length === 0) return [];
  const config = input.project.configPath;
  const context = input.caches.typeScriptSemanticFactsCache
    .values()
    .find(
      (context) =>
        hasQualifiedNativeContext(context) &&
        context.nativeEvidence?.contexts[0]?.id ===
          input.snapshot.contexts[0]?.id,
    );
  if (context === undefined) return [];
  const problems: string[] = [];
  const byId = new Map(
    input.facts.map((fact) => [fact.nativeEvidence?.requestId, fact]),
  );
  const modules = new Map(
    context.nativeInventory?.modules.map((item) => [item.requestId, item]),
  );
  const roots = context.nativeInventory?.roots.map((entry) => entry.root) ?? [];
  for (const { record: importRecord, evidence } of unresolved) {
    const nativeEvidence =
      evidence ?? missingNativeEvidence(context, importRecord);
    const requestId = nativeEvidence?.requestId;
    if (requestId === undefined || !ids.has(requestId)) continue;
    const premises = modules.get(requestId);
    if (premises === undefined) continue;
    let fact = byId.get(requestId);
    if (fact === undefined) {
      fact = {
        consumerConfigPath: config,
        importRecord,
        physicalTargetPath: null,
        physicalTargetProvenance: null,
        referenceRequirement: null,
        nativeEvidence,
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
      },
    });
    if (coverage === null) continue;
    const assessment = assessUnselectedFrameworkRequest({
      context: context.nativeEvidence!.contexts[0]!,
      premises,
      discovery: fact.supplementalDiscovery!,
      coverage,
      roots,
      emitOptions: input.project.options,
      occurrence: fact.importRecord,
    });
    fact.supplementalAssessment = assessment;
    input.caches.supplementalAssessments!.push(assessment);
  }
  return problems;
}
