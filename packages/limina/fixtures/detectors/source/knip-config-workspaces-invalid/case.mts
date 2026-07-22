import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'detector'],
  expected: {
    additionalCodes: [],
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.sourceKnipConfigInvalid,
        packageName: '<workspace>',
        scope: 'source.knip.workspaces',
        task: 'source:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.sourceKnipConfigInvalid,
  },
  id: 'source/knip-config-workspaces-invalid',
  kind: 'filesystem',
  setup: [],
  tools: ['typescript'],
});
