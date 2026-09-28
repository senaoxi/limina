import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import { createSourceDiagnosticFinding } from './finding-utils';
import type { SourceCheckState } from './run-state';

type SourceRoutePhaseInput = Readonly<
  Pick<
    SourceCheckState,
    'checkItems' | 'checks' | 'findings' | 'graphRoute' | 'projectPaths'
  >
>;

export async function runSourceRoutePhase(
  state: SourceRoutePhaseInput,
): Promise<void> {
  state.checkItems.start('source graph routes');
  state.findings.push(
    ...state.graphRoute.diagnostics.map((diagnostic) =>
      createSourceDiagnosticFinding({
        checkerName: diagnostic.checkerName,
        code: LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance,
        facts: {
          checkerName: diagnostic.checkerName,
          configPath: diagnostic.filePath,
          kind: 'checker-route',
        },
        filePath: diagnostic.filePath,
        lines: diagnostic.detailLines,
        reason: diagnostic.reason,
        title: diagnostic.title,
      }),
    ),
  );
  state.checks.add(state.projectPaths.length);
  state.checkItems.record('source graph routes');
}
