import type { CandidateBuildPlan } from './analysis-admission';
import type { DependencyAnalysisResult } from './types';

export const pendingDeclarationValidation =
  'Declaration contexts require validation against staged generated configurations.';

/**
Policy prerequisites are independent of native compilation obligations.
*/
export function assessDeclarationContexts(
  analysis: DependencyAnalysisResult,
  candidate: CandidateBuildPlan,
  configs: ReadonlySet<string>,
): { denied: string[]; unknown: string[] } {
  const result = { denied: [] as string[], unknown: [] as string[] };
  const evidenceRecords = analysis.declarationEvidence ?? [];
  for (const evidence of evidenceRecords)
    if (
      configs.has(evidence.sourceConfig) &&
      evidence.completeness !== 'complete'
    )
      result.unknown.push(
        `${evidence.sourceConfig}: Checker declaration request inventory is incomplete.`,
      );
  const decisions = (analysis.declarationContexts ?? []).filter((decision) =>
    configs.has(decision.consumerConfig),
  );
  for (const decision of decisions) {
    const selection = decision.selection;
    const location = `${decision.consumerConfig}: ${decision.file.lexicalPath}`;
    if (
      selection.state === 'awaiting-selection' ||
      selection.state === 'unavailable'
    )
      result.unknown.push(
        `${location}: ${selection.reason} Candidates: ${decision.coverage.members.map((member) => member.configId).join(', ')}`,
      );
    else if (
      selection.state === 'selected' &&
      candidate.references.every(
        (edge) =>
          !(
            edge.from === decision.consumerConfig &&
            edge.to === selection.config
          ),
      )
    )
      result.denied.push(
        `${location}: missing declaration context reference to ${selection.config}.`,
      );
  }
  if (decisions.length > 0 || analysis.declarationValidation !== undefined) {
    const validation = analysis.declarationValidation;
    if (validation === undefined)
      result.unknown.push(pendingDeclarationValidation);
    else if (validation.state === 'denied')
      result.denied.push(...validation.diagnostics);
    else if (validation.state === 'unavailable')
      result.unknown.push(...validation.diagnostics);
    else
      for (const decision of decisions) {
        if (
          validation.receipts.every(
            (receipt) => receipt.sourceConfig !== decision.consumerConfig,
          )
        )
          result.unknown.push(
            `${decision.consumerConfig}: declaration context receipt is missing.`,
          );
      }
  }
  return result;
}
