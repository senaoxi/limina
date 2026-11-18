import type ts from 'typescript';
import type { NativeEvidenceContext } from '../../domain/analysis/native-context';
import type { NativeCoverage } from '../../domain/analysis/native-coverage';
import { freezeNativeData } from '../../domain/analysis/native-evidence-freeze';
import type { NativeCompilationObligation } from '../../domain/analysis/native-obligation';
import type { ImportRecord } from '../import-analysis/records';
import type { SupplementalResolution } from '../import-analysis/supplemental-resolution';
import type { NativeModulePremises } from '../typescript-semantic/native-context-inventory';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import { independentModuleInputAbsence } from '../typescript-semantic/native-module-impact';
import {
  existence,
  obligationIdentity,
} from '../typescript-semantic/native-obligation-projection';
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

export function assessUnselectedFrameworkRequest(input: {
  context: NativeEvidenceContext;
  premises: NativeModulePremises;
  discovery: SupplementalResolution;
  coverage: NativeCoverage;
  roots: readonly string[];
  emitOptions: ts.CompilerOptions;
  occurrence: ImportRecord;
}): SupplementalAssessment {
  const site = { context: input.context, requestId: input.premises.requestId };
  const independent = independentModuleInputAbsence({
    role: input.premises.role,
    options: input.premises.options,
    roots: input.roots,
    target: input.coverage.target.lexicalPath,
  });
  const reason = 'framework-semantic-authority-required';
  const assessment: SupplementalAssessment = freezeNativeData({
    ...input,
    source: 'qualified-supplement',
    baselineContextId: input.context.id,
    requestId: site.requestId,
    capability: reason,
    obligation: {
      ...obligationIdentity(site),
      id: nativeFingerprint([input.context.id, site.requestId, reason]),
      targetConfigId:
        input.coverage.members.length === 1
          ? input.coverage.members[0]!.configId
          : null,
      existence: existence(site, independent ?? { state: 'unknown', reason }),
      structure: { state: 'unknown', reason },
      artifact: { state: 'unknown', reason },
    },
  });
  liveAssessments.add(assessment);
  return assessment;
}
