import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'detector'],
  expected: {
    additionalCodes: [],
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.sourceUnusedWorkspaceDependency,
        evidence: [
          {
            label: 'dependency',
            value:
              '@fixture/source-unused-dependency-target (dependencies: workspace:*)',
          },
        ],
        externalCode: 'dependencies',
        packageManifestPath: 'packages/app/package.json',
        packageName: '@fixture/source-unused-dependency-app',
        task: 'source:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.sourceUnusedWorkspaceDependency,
  },
  id: 'source/unused-workspace-dependency',
  kind: 'filesystem',
  setup: [],
  tools: ['typescript'],
});
