import { LIMINA_CHECK_ISSUE_CODES as C } from '../issue-code-values';
import {
  defineIssueRule,
  type LiminaCheckIssueRuleDefinition,
} from './definition';

export const checkerPackageProofIssueRules: readonly LiminaCheckIssueRuleDefinition[] =
  [
    defineIssueRule({
      code: C.checkerBuildFailed,
      description: 'Checker build execution failed for one or more targets.',
      task: 'checker:build',
    }),
    defineIssueRule({
      code: C.checkerPeerDependencyMissing,
      description:
        'A configured checker is missing a required peer dependency.',
      task: 'checker:build',
    }),
    defineIssueRule({
      code: C.checkerTargetSelectionFailed,
      description: 'Limina could not select the checker target to execute.',
      task: 'checker:build',
    }),
    defineIssueRule({
      code: C.checkerTypecheckFailed,
      description:
        'Checker typecheck execution failed for one or more entries.',
      task: 'checker:typecheck',
    }),
    defineIssueRule({
      code: C.commandFailed,
      description: 'A configured command step exited unsuccessfully.',
      task: 'command',
    }),
    defineIssueRule({
      code: C.pipelineCommandFailed,
      description:
        'Deprecated legacy alias for command failures; new issues use LIMINA_COMMAND_FAILED.',
      status: 'retired',
      task: 'command',
    }),
    defineIssueRule({
      code: C.packageAttw,
      description:
        'Are The Types Wrong reported a package type-resolution issue.',
      task: 'package:check',
    }),
    defineIssueRule({
      code: C.packageBoundary,
      description: 'A package boundary or export rule was violated.',
      task: 'package:check',
    }),
    defineIssueRule({
      code: C.packageCheckFailed,
      description:
        'Package check failed before a more specific rule was recorded.',
      task: 'package:check',
    }),
    defineIssueRule({
      code: C.packageManifestInvalid,
      description: 'A package manifest is invalid for package checking.',
      task: 'package:check',
    }),
    defineIssueRule({
      code: C.packagePublint,
      description: 'Publint reported a package publishing issue.',
      task: 'package:check',
    }),
    defineIssueRule({
      code: C.proofAllowlistInvalid,
      description: 'Proof check allowlist configuration is invalid.',
      task: 'proof:check',
    }),
    defineIssueRule({
      code: C.proofCheckerCoverageInvalid,
      description: 'Checker coverage metadata is invalid for proof checking.',
      task: 'proof:check',
    }),
    defineIssueRule({
      code: C.proofCheckFailed,
      description:
        'Proof check failed before a more specific rule was recorded.',
      task: 'proof:check',
    }),
    defineIssueRule({
      code: C.proofDefaultTsconfigInvalid,
      description:
        'A default tsconfig does not satisfy proof-check requirements.',
      task: 'proof:check',
    }),
    defineIssueRule({
      code: C.proofDuplicateGraphCoverage,
      description:
        'A declaration-emitting source file is covered by multiple generated dts graph entries.',
      task: 'proof:check',
    }),
    defineIssueRule({
      code: C.proofDuplicateSourceOwner,
      description:
        'An implementation source file is owned by multiple ordinary typecheck configs.',
      task: 'proof:check',
    }),
    defineIssueRule({
      code: C.proofSourceBoundaryMismatch,
      description: 'Source ownership does not match proof-check boundaries.',
      task: 'proof:check',
    }),
    defineIssueRule({
      code: C.proofUncoveredSourceFile,
      description: 'A source file is not covered by any configured checker.',
      task: 'proof:check',
    }),
  ];
