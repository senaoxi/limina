import { LIMINA_CHECK_ISSUE_CODES as C } from '../issue-code-values';
import {
  defineIssueRule,
  type LiminaCheckIssueRuleDefinition,
} from './definition';

export const releaseSourceIssueRules: readonly LiminaCheckIssueRuleDefinition[] =
  [
    defineIssueRule({
      code: C.releaseCheckFailed,
      description:
        'Release check failed before a more specific rule was recorded.',
      task: 'release:check',
    }),
    defineIssueRule({
      code: C.releaseConsistency,
      description: 'Release metadata or package output is inconsistent.',
      status: 'planned',
      task: 'release:check',
    }),
    defineIssueRule({
      code: C.releaseContentHash,
      description: 'Release content hash validation failed.',
      task: 'release:check',
    }),
    defineIssueRule({
      code: C.releasePackedManifest,
      description: 'The packed package manifest is not release-ready.',
      task: 'release:check',
    }),
    defineIssueRule({
      code: C.releaseRegistry,
      description: 'Release registry validation failed.',
      task: 'release:check',
    }),
    defineIssueRule({
      code: C.releaseTarballHygiene,
      description: 'Release tarball contents failed hygiene checks.',
      task: 'release:check',
    }),
    defineIssueRule({
      code: C.sourceAmbientDeclarationConfigInvalid,
      description: 'Shared ambient declaration configuration is invalid.',
      task: 'source:check',
    }),
    defineIssueRule({
      code: C.sourceAmbientDeclarationReferenceUnauthorized,
      description:
        'A triple-slash path reference targets an ambient declaration without authorization.',
      task: 'source:check',
    }),
    defineIssueRule({
      code: C.sourceAmbientDeclarationSharedUnauthorized,
      description:
        'An ambient declaration is consumed by multiple source owners without authorization.',
      task: 'source:check',
    }),
    defineIssueRule({
      code: C.sourceCheckFailed,
      description:
        'Source check failed before a more specific rule was recorded.',
      task: 'source:check',
    }),
    defineIssueRule({
      code: C.sourceCrossGovernanceBoundary,
      description:
        'A current-region source import resolves beyond a stopped or excluded governance boundary.',
      task: 'source:check',
    }),
    defineIssueRule({
      code: C.sourceImportAuthorityInvalid,
      description: 'Source import authority configuration is invalid.',
      task: 'source:check',
    }),
    defineIssueRule({
      code: C.sourceKnipBuildScriptUnsupported,
      description:
        'A package build script cannot be mapped to source analysis.',
      task: 'source:check',
    }),
    defineIssueRule({
      code: C.sourceKnipConfigInvalid,
      description: 'Knip source-analysis configuration is invalid.',
      task: 'source:check',
    }),
    defineIssueRule({
      code: C.sourceOwnerInvalid,
      description:
        'Source owner configuration or package ownership is invalid.',
      task: 'source:check',
    }),
    defineIssueRule({
      code: C.sourcePackageImportInvalid,
      description: 'A source package import resolves to an invalid target.',
      task: 'source:check',
    }),
    defineIssueRule({
      code: C.sourcePackageImportUnauthorized,
      description:
        'A source import is not authorized by the nearest package owner.',
      task: 'source:check',
    }),
    defineIssueRule({
      code: C.sourceRelativeImportEscapesScope,
      description: 'A relative source import escapes its owner scope.',
      task: 'source:check',
    }),
    defineIssueRule({
      code: C.sourceResourceModuleNotFound,
      description: 'A resource import does not resolve to a physical file.',
      task: 'source:check',
    }),
    defineIssueRule({
      code: C.sourceResourceModuleTypeUndeclared,
      description:
        'A physical resource import has no declaration visible to its checker project.',
      task: 'source:check',
    }),
    defineIssueRule({
      code: C.sourceTsconfigGovernance,
      description:
        'A source tsconfig is missing or outside checker governance.',
      task: 'source:check',
    }),
    defineIssueRule({
      code: C.sourceUnusedModule,
      description:
        'A source module is not reachable from package entry points.',
      task: 'source:check',
    }),
    defineIssueRule({
      code: C.sourceUnusedWorkspaceDependency,
      description: 'A workspace dependency is not visible to source analysis.',
      task: 'source:check',
    }),
  ];
