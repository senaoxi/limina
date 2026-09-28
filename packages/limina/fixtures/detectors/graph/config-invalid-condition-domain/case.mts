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
        evidence: [{ label: 'field', value: 'graph.conditionDomains[0].name' }],
        filePath: 'limina.config.mts',
        task: 'graph:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
  },
  id: 'graph/config-invalid-condition-domain',
  kind: 'filesystem',
  setup: [],
  tools: [],
});
