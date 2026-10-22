import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'detector'],
  expected: {
    additionalCodes: [],
    exitCode: 1,
    issues: [
      {
        checkerName: 'tsc',
        code: LIMINA_CHECK_ISSUE_CODES.checkerBuildAdmissionRejected,
        evidence: [
          {
            label: 'governance diagnostic',
            value: LIMINA_CHECK_ISSUE_CODES.graphAccessDenied,
          },
          { label: 'execution stage', value: 'mutation' },
        ],
        task: 'checker:build',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.checkerBuildAdmissionRejected,
  },
  id: 'checker/admission-denied-reference',
  kind: 'filesystem',
  tools: ['typescript'],
});
