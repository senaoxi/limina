import type {
  DependencyAnalysisResult,
  InputTopologyResult,
  LiminaArtifactNamespace,
} from 'limina/internal/migration';
import {
  analyzeProjectDependencies,
  formatErrorMessage,
  readInputTopology,
} from 'limina/internal/migration';
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
