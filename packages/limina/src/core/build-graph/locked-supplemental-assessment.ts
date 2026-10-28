import type {
  CheckerProjectConfigCache,
  VueProjectSemanticIdentity,
} from '#checkers';
import { deriveNativeCoverage } from '../../domain/analysis/native-coverage';
import { summarizeCompilationObligation } from '../../domain/analysis/native-obligation';
import type { ImportAnalysisContext } from '../import-analysis/runner';
import { discoverSupplementalTarget } from '../import-analysis/supplemental-resolution';
import { createImportRecordIdentity } from '../typescript-semantic/import-record';
import { captureModulePremises } from '../typescript-semantic/native-context-inventory';
import { observeNativeFileIdentity } from '../typescript-semantic/native-file-identity';
import { nativeObservedProgram } from '../typescript-semantic/native-program-api';
import { VueSemanticContext } from '../vue-semantic/context-handle';
import type { CheckerOwnershipDiscovery } from './checker-ownership-discovery';
import type { CheckerDependencyFact } from './checker-ownership-types';
import { prepareLockedSemanticProject } from './locked-semantic-project';
import {
  assessPendingSupplement,
  type SupplementalAssessment,
} from './pending-supplemental-assessment';

interface RebindInput {
  discovery: CheckerOwnershipDiscovery;
  facts: CheckerDependencyFact[];
  rootDir: string;
  importAnalysis: ImportAnalysisContext;
  projectConfigCache?: CheckerProjectConfigCache;
}
export function rebindSupplementalAssessments(
  input: RebindInput,
): SupplementalAssessment[] {
  return input.discovery.plan.dependencyFacts.flatMap((fact) => {
    if (fact.supplementalAssessment === undefined) return [];
    const current = rebindAssessment(input, fact);
    const bound = input.facts.find(
      (item) =>
        item.consumerConfigPath === fact.consumerConfigPath &&
        hasSameOccurrence(item, fact),
    );
    if (bound !== undefined) {
      bound.supplementalAssessment = current;
      if (
        summarizeCompilationObligation(current.obligation) === 'required' &&
        current.discovery.state === 'resolved'
      )
        bound.referenceRequirement = {
          kind: 'compiler-membership',
          targetFileName: current.discovery.target,
        };
    }
    return [current];
  });
}
function hasSameOccurrence(
  left: CheckerDependencyFact,
  right: CheckerDependencyFact,
): boolean {
  return (
    createImportRecordIdentity({
      ...left.importRecord,
      compilerRequest: undefined,
    }) ===
    createImportRecordIdentity({
      ...right.importRecord,
      compilerRequest: undefined,
    })
  );
}
function rebindAssessment(
  input: RebindInput,
  fact: CheckerDependencyFact,
): SupplementalAssessment {
  const previous = fact.supplementalAssessment!;
  const project = input.discovery.projectByConfigPath.get(
    fact.consumerConfigPath,
  )!;
  const authority = input.discovery.plan.typeConfigs.get(
    project.configPath,
  )!.semanticAuthority;
  if (authority.kind !== 'locked' || authority.family !== 'vue')
    throw new Error(
      'Supplemental request has no current Vue semantic authority.',
    );
  const owner = input.discovery.projectByConfigPath.get(
    previous.obligation.targetConfigId!,
  )?.context.vueSemanticIdentity;
  const consumer = prepareLockedSemanticProject({
    ...input,
    project,
    authority,
  }).context.vueSemanticIdentity;
  const coverage = input.discovery.sourceConfigCoverage;
  if (owner === undefined || consumer === undefined || coverage === undefined)
    throw new Error('Supplemental capability became unavailable during lock.');
  const premises = currentPremises(consumer, fact);
  const discovery = (
    input.importAnalysis.resolveSupplementalImport ?? discoverSupplementalTarget
  )({
    contextId: previous.context.id,
    requestId: premises.requestId,
    importer: fact.importRecord.filePath,
    specifier: fact.importRecord.specifier,
    mode: premises.mode,
    options: premises.options!,
    configPath:
      typeof premises.options!.configFilePath === 'string'
        ? premises.options!.configFilePath
        : consumer.configPath,
    extensions: [...consumer.extensions],
  });
  if (discovery.state !== 'resolved')
    throw new Error(
      `Supplemental target became ${discovery.state} during lock: ${discovery.reason}`,
    );
  return assessPendingSupplement({
    baseline: fact.nativeEvidence!.origin.context,
    premises,
    discovery,
    coverage: deriveNativeCoverage(
      coverage,
      observeNativeFileIdentity(discovery.target, coverage.inputVersion),
    ),
    owner,
    consumer,
    roots: consumer.fileNames,
    emitOptions: consumer.options,
    importer: fact.importRecord.filePath,
    specifier: fact.importRecord.specifier,
    occurrence: fact.importRecord,
    locked: true,
  });
}
function currentPremises(
  identity: VueProjectSemanticIdentity,
  fact: CheckerDependencyFact,
) {
  const previous = fact.supplementalAssessment!;
  const context = new VueSemanticContext(identity);
  try {
    const source = context.program.getSourceFile(fact.importRecord.filePath);
    const requests =
      source === undefined
        ? []
        : context.compilerRequests.collect(context.program, source).filter(
            (request) =>
              createImportRecordIdentity({
                ...request.record,
                compilerRequest: undefined,
              }) === createImportRecordIdentity(fact.importRecord) &&
              request.role === previous.premises.role &&
              request.mode === previous.premises.mode,
          );
    if (requests.length !== 1)
      throw new Error(
        'Supplemental occurrence cannot be rebound to current Compiler Inventory.',
      );
    const request = requests[0]!;
    const premises = captureModulePremises(
      { ...request, source: request.sourceFile, requestId: previous.requestId },
      nativeObservedProgram(
        context.program,
        context.tsModule,
        context.compilerRequests.optionsBySource,
      ),
      context.tsModule,
    );
    if (
      premises.sourceFingerprint !== previous.premises.sourceFingerprint ||
      premises.options === undefined
    )
      throw new Error(
        'Supplemental source/options changed or became unavailable during lock.',
      );
    return {
      ...premises,
      ...(previous.premises.sourceLoadGap !== undefined && {
        sourceLoadGap: previous.premises.sourceLoadGap,
      }),
    };
  } finally {
    context.dispose();
  }
}
