import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { GraphConfigInvalidFinding, GraphFinding } from './findings';
import type { GraphCheckState } from './run-state';

function addGraphRouteDiagnostic(
  state: GraphCheckState,
  diagnostic: GraphCheckState['graphRoute']['diagnostics'][number],
): void {
  const filePath = diagnostic.filePath ?? state.config.configPath;

  state.findings.push({
    checkerName: diagnostic.checkerName,
    code: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
    evidence: [{ label: 'checker', value: diagnostic.checkerName }],
    facts: {
      configPath: state.config.configPath,
      kind: 'route',
    },
    filePath,
    locations: [{ filePath, label: 'checker graph route' }],
    presentation: {
      detailLines: diagnostic.detailLines,
      reason: diagnostic.reason,
      title: diagnostic.title,
    },
    task: 'graph:check',
  } satisfies GraphConfigInvalidFinding);
}

function addWorkspaceExportDiagnostic(
  findings: GraphFinding[],
  diagnostic: GraphCheckState['workspaceExports']['diagnostics'][number],
  configPath: string,
): void {
  findings.push({
    code: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
    evidence: [{ label: 'package export', value: diagnostic.subpath }],
    facts: {
      configPath,
      kind: 'workspace-export',
      packageManifestPath: diagnostic.packageJsonPath,
      packageName: diagnostic.packageName,
    },
    filePath: diagnostic.packageJsonPath,
    locations: [
      {
        label: 'package manifest',
        packageManifestPath: diagnostic.packageJsonPath,
      },
    ],
    packageManifestPath: diagnostic.packageJsonPath,
    packageName: diagnostic.packageName,
    presentation: {
      detailLines: diagnostic.detailLines,
      fix: diagnostic.fix,
      reason: diagnostic.reason,
      title: diagnostic.title,
    },
    task: 'graph:check',
  } satisfies GraphConfigInvalidFinding);
}

export function runGraphRoutePhase(state: GraphCheckState): void {
  state.checkItems.start('source graph routes');
  for (const diagnostic of state.graphRoute.diagnostics) {
    addGraphRouteDiagnostic(state, diagnostic);
  }

  for (const diagnostic of state.workspaceExports.diagnostics) {
    addWorkspaceExportDiagnostic(
      state.findings,
      diagnostic,
      state.config.configPath,
    );
  }

  state.checks.add(state.projectPaths.length);
  state.checkItems.record('source graph routes');
}
