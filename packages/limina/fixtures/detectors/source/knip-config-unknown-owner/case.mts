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
        scope: 'source.knip.workspaces["@fixture/not-activated"]',
        task: 'source:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.sourceKnipConfigInvalid,
  },
  id: 'source/knip-config-unknown-owner',
  kind: 'filesystem',
  setup: [],
  tools: ['typescript'],
});
