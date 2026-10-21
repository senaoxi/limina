import ts from 'typescript';
import { collectSourceConfigCoverage } from '../../core/build-graph/source-config-coverage';
import type { SourceConfigCoverageIndex } from '../../domain/analysis/native-coverage';

// The fixture explicitly selects U before parsing. Consumer roots and successful
// resolutions never supply members; the real configs do.
export function readFixtureSourceCoverage(
  sourceConfigIds: readonly string[],
): SourceConfigCoverageIndex {
  return collectSourceConfigCoverage({
    universe: {
      id: 'fixture-selected-source-configs',
      revision: 'fixture',
      scopeFingerprint: JSON.stringify(sourceConfigIds),
      inputVersion: 'fixture',
      selectionEvidenceId: 'explicit-fixture-entry-selection',
      sourceConfigIds,
      discovery: 'closed',
    },
    parse: (config) =>
      ts.getParsedCommandLineOfConfigFile(
        config,
        {},
        {
          ...ts.sys,
          onUnRecoverableConfigFileDiagnostic: () => {},
        },
      ),
  });
}
