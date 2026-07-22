import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'detector'],
  expected: {
    additionalCodes: [],
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.sourceUnusedModule,
        externalCode: 'files',
        filePath: 'packages/pkg/src/unused.ts',
        packageManifestPath: 'packages/pkg/package.json',
        packageName: '@fixture/source-unused-module',
        task: 'source:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.sourceUnusedModule,
  },
  id: 'source/unused-module',
  kind: 'filesystem',
  setup: [],
  tools: ['typescript'],
});
