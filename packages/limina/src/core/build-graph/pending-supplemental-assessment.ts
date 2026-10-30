import type { VueProjectSemanticIdentity } from '#checkers';
import type ts from 'typescript';
import type { NativeEvidenceContext } from '../../domain/analysis/native-context';
import type { NativeCoverage } from '../../domain/analysis/native-coverage';
import { freezeNativeData } from '../../domain/analysis/native-evidence-freeze';
import type { NativeCompilationObligation } from '../../domain/analysis/native-obligation';
import type { ImportRecord } from '../import-analysis/records';
import type { SupplementalResolution } from '../import-analysis/supplemental-resolution';
import { compilerFileKey } from '../typescript-semantic/compiler-coverage';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import type { NativeModulePremises } from '../typescript-semantic/native-context-inventory';
import {
  nativeFingerprint,
  observeNativeFileIdentity,
} from '../typescript-semantic/native-file-identity';
import {
  evaluateModuleImpact,
  independentModuleInputAbsence,
  type NativeModuleImpact,
} from '../typescript-semantic/native-module-impact';
import {
  artifact,
  existence,
  obligationIdentity,
  structure,
  targetConfig,
} from '../typescript-semantic/native-obligation-projection';
import { nativeObservedProgram } from '../typescript-semantic/native-program-api';
import {
  type NativeReferenceObservation,
  observedDeclarationRedirect,
  observeNativeReference,
} from '../typescript-semantic/reference-redirect';
import { VueSemanticContext } from '../vue-semantic/context-handle';
import { getVueServiceScript } from '../vue-semantic/dependency';

const liveAssessments = new WeakSet<SupplementalAssessment>();

export function isCurrentLockedSupplement(
  value: SupplementalAssessment,
): boolean {
  return (
    liveAssessments.has(value) && value.context.authority.phase === 'locked'
  );
}

export interface SupplementalAssessment {
  readonly source: 'qualified-supplement';
  readonly baselineContextId: string;
  readonly requestId: string;
  readonly discovery: SupplementalResolution;
  readonly context: NativeEvidenceContext;
  readonly coverage: NativeCoverage;
  readonly capability: string;
  readonly premises: NativeModulePremises;
  readonly roots: readonly string[];
  readonly emitOptions: ts.CompilerOptions;
  readonly occurrence: ImportRecord;
  readonly obligation: NativeCompilationObligation;
}

/** Observe the consumer's actual Vue resolver before choosing a compiler
 * member. Oxc's physical target remains independent discovery evidence. */
export function resolveSupplementalVueTarget(input: {
  consumer: VueProjectSemanticIdentity;
  premises: NativeModulePremises;
  importer: string;
  specifier: string;
}): string | undefined {
  if (input.premises.options === undefined) return undefined;
  const consumer = new VueSemanticContext(input.consumer);
  try {
    return consumer.resolveSupplementalModule?.(
      input.specifier,
      input.importer,
      input.premises.options,
      input.premises.mode,
    ).resolvedModule?.resolvedFileName;
  } finally {
    consumer.dispose();
  }
}

/** Pending only asks the adapter for resolution and script classification.
 * Locked evaluation may observe its current reference map; neither path
 * changes the original Native snapshot or grants Pending loading. */
export function assessPendingSupplement(input: {
  baseline: NativeEvidenceContext;
  premises: NativeModulePremises;
  discovery: SupplementalResolution;
  coverage: NativeCoverage;
  owner: VueProjectSemanticIdentity;
  consumer: VueProjectSemanticIdentity;
  importer: string;
  specifier: string;
  roots: readonly string[];
  emitOptions: ts.CompilerOptions;
  occurrence: ImportRecord;
  locked?: boolean;
}): SupplementalAssessment {
  const capability = nativeFingerprint([input.owner.id, input.consumer.id]);
  const context: NativeEvidenceContext = freezeNativeData({
    ...input.baseline,
    authority: input.locked
      ? {
          phase: 'locked',
          family: 'vue',
          selectionEvidenceIds: [input.baseline.id],
        }
      : input.baseline.authority,
    id: nativeFingerprint([
      'supplement',
      input.baseline.id,
      input.discovery,
      input.premises,
      input.coverage,
      capability,
      input.locked ?? false,
    ]),
    collectionId: nativeFingerprint([
      'supplement',
      input.baseline.collectionId,
      capability,
      input.locked ?? false,
    ]),
    inputs: {
      ...input.baseline.inputs,
      options: nativeFingerprint(effectiveCompilerOptions(input.emitOptions)),
      roots: nativeFingerprint(input.roots),
      rawReferences: nativeFingerprint(input.consumer.projectReferences ?? []),
      hostContract: 'qualified-supplement-v1',
      toolchain: capability,
    },
  });
  const site = { context, requestId: input.premises.requestId };
  const reference = supplementReference(input);
  const target = targetConfig(input.coverage, reference);
  const impact = supplementImpact(input, reference);
  const assessment: SupplementalAssessment = freezeNativeData({
    source: 'qualified-supplement',
    premises: input.premises,
    roots: input.roots,
    emitOptions: effectiveCompilerOptions(input.emitOptions),
    occurrence: input.occurrence,
    baselineContextId: input.baseline.id,
    requestId: site.requestId,
    discovery: input.discovery,
    context,
    coverage: input.coverage,
    capability,
    obligation: {
      ...obligationIdentity(site),
      id: nativeFingerprint([context.id, site.requestId]),
      targetConfigId: target,
      existence: existence(site, impact),
      structure: structure(site, target, reference),
      artifact: artifact(observedDeclarationRedirect(reference)),
    },
  });
  liveAssessments.add(assessment);
  return assessment;
}
function supplementImpact(
  input: Parameters<typeof assessPendingSupplement>[0],
  reference: NativeReferenceObservation | undefined,
): NativeModuleImpact {
  const { premises, discovery } = input;
  const independent = independentModuleInputAbsence({
    role: premises.role,
    options: premises.options,
    roots: input.roots,
    target: input.coverage.target.lexicalPath,
  });
  if (independent !== undefined) return independent;
  if (premises.sourceLoadGap !== undefined)
    return { state: 'unknown', reason: premises.sourceLoadGap };
  if (premises.ownAmbient)
    return { state: 'absent', rule: 'compiler-local-ambient-module' };
  if (premises.options === undefined || discovery.state !== 'resolved')
    return {
      state: 'unknown',
      reason: 'supplement-request-premises-unavailable',
    };
  if (input.coverage.state !== 'unique')
    return {
      state: 'unknown',
      reason: 'supplement-target-coverage-unqualified',
    };
  if (
    input.consumer.toolchain.tsModule.version !==
    input.baseline.inputs.typescriptVersion
  )
    return { state: 'unknown', reason: 'supplement-compiler-version-mismatch' };
  const owner = new VueSemanticContext(input.owner);
  const consumer = new VueSemanticContext(input.consumer);
  try {
    const raw = consumer.resolveSupplementalModule?.(
      input.specifier,
      input.importer,
      premises.options,
      premises.mode,
    );
    const target = raw?.resolvedModule;
    if (
      target === undefined ||
      !hasSameSupplementalTarget(target.resolvedFileName, input.coverage)
    )
      return {
        state: 'unknown',
        reason: 'supplement-checker-resolution-mismatch',
      };
    const service = getVueServiceScript({
      context: consumer,
      fileName: target.resolvedFileName,
    })?.serviceScript;
    const ownerService = getVueServiceScript({
      context: owner,
      fileName: target.resolvedFileName,
    })?.serviceScript;
    if (
      service?.extension === undefined ||
      service.scriptKind === undefined ||
      service.extension !== target.extension ||
      service.extension !== ownerService?.extension ||
      service.scriptKind !== ownerService.scriptKind
    )
      return {
        state: 'unknown',
        reason: 'supplement-service-classification-unavailable',
      };
    const impact = evaluateModuleImpact({
      target,
      compiler: consumer.tsModule,
      inputOptions: premises.options,
      emitOptions: effectiveCompilerOptions(input.emitOptions),
      reference,
      sourceIsExternal: premises.sourceIsExternal,
      sourceIsDeclaration: premises.sourceIsDeclaration,
      excludedDocumentation: premises.excludedDocumentation,
      service: { extension: service.extension, scriptKind: service.scriptKind },
    });
    return impact.state === 'present' &&
      input.baseline.inputs.compilationScope !==
        'generated-declaration-project-v1' &&
      !input.emitOptions.composite
      ? {
          state: 'unknown',
          reason: 'fixed-root-composite-compilation-scope-not-established',
        }
      : impact;
  } finally {
    consumer.dispose();
    owner.dispose();
  }
}

function supplementReference(
  input: Parameters<typeof assessPendingSupplement>[0],
): NativeReferenceObservation | undefined {
  if (!input.locked || input.discovery.state !== 'resolved') return undefined;
  const context = new VueSemanticContext(input.consumer);
  try {
    return observeNativeReference(
      nativeObservedProgram(
        context.program,
        context.tsModule,
        context.compilerRequests.optionsBySource,
      ),
      input.coverage.target.lexicalPath,
      context.tsModule,
    );
  } finally {
    context.dispose();
  }
}

function hasSameSupplementalTarget(
  file: string,
  coverage: NativeCoverage,
): boolean {
  if (compilerFileKey(file) !== compilerFileKey(coverage.target.lexicalPath))
    return false;
  const expected = coverage.target.physical;
  if (expected.state !== 'verified') return false;
  const actual = observeNativeFileIdentity(
    file,
    expected.inputVersion,
  ).physical;
  return (
    actual.state === 'verified' && actual.canonicalId === expected.canonicalId
  );
}
