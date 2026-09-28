import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'detector'],
  expected: {
    additionalCodes: [],
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationReferenceUnauthorized,
        filePath: 'packages/pkg/src/index.ts',
        packageManifestPath: 'packages/pkg/package.json',
        packageName: '@fixture/source-ambient-reference',
        scope: 'source.declarations.ambient[0]',
        task: 'source:check',
      },
    ],
    primaryCode:
      LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationReferenceUnauthorized,
  },
  id: 'source/ambient-reference-unauthorized',
  kind: 'filesystem',
  setup: [],
  tools: ['typescript'],
});
