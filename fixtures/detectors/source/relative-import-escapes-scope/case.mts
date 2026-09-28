import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'detector'],
  expected: {
    additionalCodes: [],
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.sourceRelativeImportEscapesScope,
        filePath: 'packages/app/src/index.ts',
        packageManifestPath: 'packages/app/package.json',
        packageName: '@fixture/source-relative-app',
        task: 'source:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.sourceRelativeImportEscapesScope,
  },
  id: 'source/relative-import-escapes-scope',
  kind: 'filesystem',
  setup: [],
  tools: ['typescript'],
});
