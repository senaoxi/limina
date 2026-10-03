import type { InputTopologyResult } from 'limina/internal/core/build-graph/input-topology';
import { readInputTopology } from 'limina/internal/core/build-graph/input-topology';
import { analyzeProjectDependencies } from 'limina/internal/core/build-graph/prepare';
import type { DependencyAnalysisResult } from 'limina/internal/core/build-graph/types';
import type { LiminaArtifactNamespace } from 'limina/internal/domain/artifacts/namespace';
import { formatErrorMessage } from 'limina/internal/logger';
import { type MigrationPlanningState, planningView } from './planning-state';

export async function collectAnalysis(
  state: MigrationPlanningState,
  artifactNamespace: LiminaArtifactNamespace,
): Promise<{
  topology: InputTopologyResult;
  analysis: DependencyAnalysisResult;
}> {
  const view = planningView(state);
  const topology = await readInputTopology(view);
  let analysis: DependencyAnalysisResult;
  try {
    analysis = topology.complete
      ? await analyzeProjectDependencies(view, {
          artifactNamespace,
          workspaceContext: topology.workspace,
        })
      : {
          complete: false,
          facts: [],
          diagnostics: topology.diagnostics.map(
            (diagnostic) => diagnostic.message,
          ),
        };
  } catch (error) {
    // Semantic preparation cannot authorize dropping native declarations or
    // excluding a readable source, including on unexpected adapter failures.
    analysis = {
      complete: false,
      facts: [],
      diagnostics: [
        `Dependency comparison failed at core analysis: ${formatErrorMessage(error)}`,
      ],
    };
  }
  return { topology, analysis };
}
