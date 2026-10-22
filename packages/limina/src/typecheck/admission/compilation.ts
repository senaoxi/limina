import { assessCompilationPrerequisites } from '../../core/build-graph/analysis-admission';
import { bindExecutionCompilationProjection } from '../../core/build-graph/compilation-prerequisite';
import type { GeneratedTsconfigGraphResult } from '../../core/build-graph/types';
import type { ExecutionReferenceClosure } from './reference-closure';
import type { ExecutionAdmissionDiagnostic } from './types';

/**
Reassess the selected invocation against live-qualified facts and actual reference identities.
*/
export function executionCompilationDiagnostics(
  graph: GeneratedTsconfigGraphResult,
  closure: ExecutionReferenceClosure,
):
  | {
      decision: 'denied' | 'unavailable';
      diagnostics: ExecutionAdmissionDiagnostic[];
    }
  | undefined {
  const analysis = requireAnalysis(graph);
  const candidate = {
    configPaths: analysis.candidate!.configPaths,
    references: closure.references
      .filter((edge) => isCurrentReference(graph, edge))
      .map((edge) => ({
        from: edge.from.sourceConfigPath,
        to: edge.to.sourceConfigPath,
      })),
    schedules: graph.dependencyEdges
      .filter((edge) => edge.kind === 'framework-schedule')
      .map((edge) => ({ from: edge.fromConfigPath, to: edge.toConfigPath })),
  };
  bindExecutionCompilationProjection(analysis.candidate!, candidate, {
    sources: graph.governedSources
      .values()
      .flatMap((units) => units.values())
      .toArray(),
    references: closure.references.filter((edge) =>
      isCurrentReference(graph, edge),
    ),
    consumers: closure.projects,
  });
  const result = assessCompilationPrerequisites(
    analysis,
    candidate,
    closure.configs,
  );
  return compilationRefusal(result);
}
function requireAnalysis(graph: GeneratedTsconfigGraphResult) {
  const analysis = graph.dependencyAnalysis;
  if (analysis?.candidate === undefined)
    throw new Error('Execution compilation evidence is unavailable.');
  return analysis;
}
function compilationRefusal(
  result: ReturnType<typeof assessCompilationPrerequisites>,
): ReturnType<typeof executionCompilationDiagnostics> {
  const reasons = [...result.denied, ...result.unknown];
  return reasons.length === 0
    ? undefined
    : {
        decision: result.denied.length > 0 ? 'denied' : 'unavailable',
        diagnostics: reasons.map((message) => ({
          code: 'LIMINA_EXECUTION_COMPILATION_UNAVAILABLE',
          message,
        })),
      };
}

function isCurrentReference(
  graph: GeneratedTsconfigGraphResult,
  edge: ExecutionReferenceClosure['references'][number],
): boolean {
  if (!['declaration', 'output'].includes(edge.kind)) return false;
  const expected = (identity: typeof edge.from) =>
    referenceConfig(graph, { identity, kind: edge.kind });
  return (
    expected(edge.from) === edge.fromConfigPath &&
    expected(edge.to) === edge.toConfigPath
  );
}

function referenceConfig(
  graph: GeneratedTsconfigGraphResult,
  input: {
    identity: ExecutionReferenceClosure['references'][number]['from'];
    kind: string;
  },
): string | undefined {
  const { identity } = input;
  const source =
    input.kind === 'declaration'
      ? graph.sourceToDts.get(identity.checkerName)
      : outputPaths(graph, identity.checkerName);
  return source?.get(identity.sourceConfigPath);
}
function outputPaths(
  graph: GeneratedTsconfigGraphResult,
  checker: string,
): Map<string, string> {
  return new Map(
    [...(graph.configToOutputBuild.get(checker) ?? [])].map(
      ([config, module]) => [config, module.path],
    ),
  );
}
