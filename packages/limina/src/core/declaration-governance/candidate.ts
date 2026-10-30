import type { VueProjectSemanticIdentity } from '#checkers';
import type ts from 'typescript';
import type { AnalysisMetricsRecorder } from '../../application/analysis/analysis-run';
import type {
  CheckerAuthority,
  DeclarationRequestReceipt,
} from '../../domain/analysis/declaration-governance';
import type { SourceConfigCoverageIndex } from '../../domain/analysis/native-coverage';

export interface DeclarationCandidateInput {
  sourceConfig: string;
  generatedConfig: string;
  checker: string;
  executionRoot?: string;
  executionIdentity?: VueProjectSemanticIdentity;
  parsed: ts.ParsedCommandLine;
  files: ReadonlyMap<string, string>;
  coverage: SourceConfigCoverageIndex;
  roots: readonly string[];
  configs: readonly string[];
  declarations: readonly string[];
  /**
   * Observe mappings without granting additional Program input membership.
   */
  referenceInputs?: readonly string[];
  referenceProjects?: readonly {
    generatedConfig: string;
    parsed: ts.ParsedCommandLine;
    checker: string;
    preset?: string;
  }[];
  requiresDelegationProof: boolean;
  metrics?: AnalysisMetricsRecorder;
}

/**
Detached facts from a checker-qualified candidate, never a graph producer.
*/
export interface DeclarationCandidateObservation {
  authority: CheckerAuthority;
  contextId: string;
  compilerVersion: string;
  sources: readonly { file: string; defaultLibrary: boolean }[];
  mappings: readonly {
    file: string;
    referenceConfig: string | null;
    declarationOutput: string | null;
    qualified: boolean;
  }[];
  requests: readonly DeclarationRequestReceipt[];
}

export class DeclarationObservationUnavailable extends Error {}

/** Retain only the declaration responsibility being validated. Standard-library
 * environments and unrelated roots do not become duplicate receipt inventories.
 * Their reads remain in the candidate's input fence. */
export function declarationCandidateRequests(
  declarations: readonly string[],
  inventory: readonly DeclarationRequestReceipt[],
): readonly DeclarationRequestReceipt[] {
  const byFile = Map.groupBy(inventory, (request) => request.file);
  const pending = [...declarations];
  const visited = new Set<string>();
  const result: DeclarationRequestReceipt[] = [];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const requests = byFile.get(file) ?? [];
    for (const request of requests) {
      result.push(request);
      if (
        request.channel !== 'library' &&
        request.target !== null &&
        /\.d\.[cm]?ts$/i.test(request.target)
      )
        pending.push(request.target);
    }
  }
  return result;
}
