import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'detector'],
  expected: {
    additionalCodes: [],
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.sourceKnipBuildScriptUnsupported,
        packageManifestPath: 'packages/pkg/package.json',
        packageName: '@fixture/source-knip-build-script',
        task: 'source:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.sourceKnipBuildScriptUnsupported,
  },
  id: 'source/knip-build-script-unsupported',
  kind: 'filesystem',
  setup: [],
  tools: ['typescript'],
});
