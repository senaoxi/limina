import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'detector'],
  copyPolicy: {
    excludedNames: [],
    includeBuildInfoFiles: false,
    includeOutputDirectories: false,
  },
  expected: {
    additionalCodes: [],
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
        evidence: [{ label: 'package export', value: '.' }],
        filePath: 'packages/internal/package.json',
        packageManifestPath: 'packages/internal/package.json',
        packageName: '@fixture/graph-invalid-export-internal',
        task: 'graph:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
  },
  id: 'graph/config-invalid-workspace-export',
  kind: 'filesystem',
  setup: [],
  tools: ['typescript'],
});
