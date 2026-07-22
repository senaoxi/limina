import type { LiminaCheckTaskName } from './snapshot';

export const LIMINA_CHECK_ISSUE_CODES = {
  checkerBuildFailed: 'LIMINA_CHECKER_BUILD_FAILED',
  checkerPeerDependencyMissing: 'LIMINA_CHECKER_PEER_DEPENDENCY_MISSING',
  checkerTargetSelectionFailed: 'LIMINA_CHECKER_TARGET_SELECTION_FAILED',
  checkerTypecheckFailed: 'LIMINA_CHECKER_TYPECHECK_FAILED',
  commandFailed: 'LIMINA_COMMAND_FAILED',
  graphAccessDenied: 'LIMINA_GRAPH_ACCESS_DENIED',
  graphCheckFailed: 'LIMINA_GRAPH_CHECK_FAILED',
  graphConditionDomainMismatch: 'LIMINA_GRAPH_CONDITION_DOMAIN_MISMATCH',
  graphConfigInvalid: 'LIMINA_GRAPH_CONFIG_INVALID',
  graphImportTargetUnmapped: 'LIMINA_GRAPH_IMPORT_TARGET_UNMAPPED',
  graphMaterializeFailed: 'LIMINA_GRAPH_MATERIALIZE_FAILED',
  graphPrepareFailed: 'LIMINA_GRAPH_PREPARE_FAILED',
  graphReferenceCycle: 'LIMINA_GRAPH_REFERENCE_CYCLE',
  graphReferenceExtra: 'LIMINA_GRAPH_REFERENCE_EXTRA',
  graphReferenceMissing: 'LIMINA_GRAPH_REFERENCE_MISSING',
  graphTargetUnreachable: 'LIMINA_GRAPH_TARGET_UNREACHABLE',
  graphWorkspaceDependencyUndeclared:
    'LIMINA_GRAPH_WORKSPACE_DEPENDENCY_UNDECLARED',
  graphWorkspaceImportOutsideGraph:
    'LIMINA_GRAPH_WORKSPACE_IMPORT_OUTSIDE_GRAPH',
  graphWorkspaceImportUnresolved: 'LIMINA_GRAPH_WORKSPACE_IMPORT_UNRESOLVED',
  graphWorkspacePackageNameMissing:
    'LIMINA_GRAPH_WORKSPACE_PACKAGE_NAME_MISSING',
  packageAttw: 'LIMINA_PACKAGE_ATTW',
  packageBoundary: 'LIMINA_PACKAGE_BOUNDARY',
  packageCheckFailed: 'LIMINA_PACKAGE_CHECK_FAILED',
  packageManifestInvalid: 'LIMINA_PACKAGE_MANIFEST_INVALID',
  packagePublint: 'LIMINA_PACKAGE_PUBLINT',
  /** @deprecated Historical alias. New command issues use LIMINA_COMMAND_FAILED. */
  pipelineCommandFailed: 'LIMINA_PIPELINE_COMMAND_FAILED',
  proofAllowlistInvalid: 'LIMINA_PROOF_ALLOWLIST_INVALID',
  proofCheckerCoverageInvalid: 'LIMINA_PROOF_CHECKER_COVERAGE_INVALID',
  proofCheckFailed: 'LIMINA_PROOF_CHECK_FAILED',
  proofDefaultTsconfigInvalid: 'LIMINA_PROOF_DEFAULT_TSCONFIG_INVALID',
  proofDuplicateGraphCoverage: 'LIMINA_PROOF_DUPLICATE_GRAPH_COVERAGE',
  proofDuplicateSourceOwner: 'LIMINA_PROOF_DUPLICATE_SOURCE_OWNER',
  proofSourceBoundaryMismatch: 'LIMINA_PROOF_SOURCE_BOUNDARY_MISMATCH',
  proofUncoveredSourceFile: 'LIMINA_PROOF_UNCOVERED_SOURCE_FILE',
  releaseCheckFailed: 'LIMINA_RELEASE_CHECK_FAILED',
  releaseConsistency: 'LIMINA_RELEASE_CONSISTENCY',
  releaseContentHash: 'LIMINA_RELEASE_CONTENT_HASH',
  releasePackedManifest: 'LIMINA_RELEASE_PACKED_MANIFEST',
  releaseRegistry: 'LIMINA_RELEASE_REGISTRY',
  releaseTarballHygiene: 'LIMINA_RELEASE_TARBALL_HYGIENE',
  sourceCheckFailed: 'LIMINA_SOURCE_CHECK_FAILED',
  sourceAmbientDeclarationConfigInvalid:
    'LIMINA_SOURCE_AMBIENT_DECLARATION_CONFIG_INVALID',
  sourceAmbientDeclarationSharedUnauthorized:
    'LIMINA_SOURCE_AMBIENT_DECLARATION_SHARED_UNAUTHORIZED',
  sourceAmbientDeclarationReferenceUnauthorized:
    'LIMINA_SOURCE_AMBIENT_DECLARATION_REFERENCE_UNAUTHORIZED',
  sourceCrossGovernanceBoundary: 'LIMINA_SOURCE_CROSS_GOVERNANCE_BOUNDARY',
  sourceImportAuthorityInvalid: 'LIMINA_SOURCE_IMPORT_AUTHORITY_INVALID',
  sourceKnipBuildScriptUnsupported:
    'LIMINA_SOURCE_KNIP_BUILD_SCRIPT_UNSUPPORTED',
  sourceKnipConfigInvalid: 'LIMINA_SOURCE_KNIP_CONFIG_INVALID',
  sourceOwnerInvalid: 'LIMINA_SOURCE_OWNER_INVALID',
  sourcePackageImportInvalid: 'LIMINA_SOURCE_PACKAGE_IMPORT_INVALID',
  sourcePackageImportUnauthorized: 'LIMINA_SOURCE_PACKAGE_IMPORT_UNAUTHORIZED',
  sourceRelativeImportEscapesScope:
    'LIMINA_SOURCE_RELATIVE_IMPORT_ESCAPES_SCOPE',
  sourceTsconfigGovernance: 'LIMINA_SOURCE_TSCONFIG_GOVERNANCE',
  sourceUnusedModule: 'LIMINA_SOURCE_UNUSED_MODULE',
  sourceUnusedWorkspaceDependency: 'LIMINA_SOURCE_UNUSED_WORKSPACE_DEPENDENCY',
  workspaceRegionOverlap: 'LIMINA_WORKSPACE_REGION_OVERLAP',
  workspaceValidationFailed: 'LIMINA_WORKSPACE_VALIDATION_FAILED',
  workspaceOutputCycle: 'LIMINA_WORKSPACE_OUTPUT_CYCLE',
  workspaceOutputRootInvalid: 'LIMINA_WORKSPACE_OUTPUT_ROOT_INVALID',
  workspacePackageIdentityConflict:
    'LIMINA_WORKSPACE_PACKAGE_IDENTITY_CONFLICT',
} as const;

export type LiminaCheckIssueCode =
  (typeof LIMINA_CHECK_ISSUE_CODES)[keyof typeof LIMINA_CHECK_ISSUE_CODES];

export type LiminaCheckIssueRuleStatus = 'active' | 'planned' | 'retired';

export interface LiminaCheckIssueRuleMetadata {
  code: LiminaCheckIssueCode;
  description: string;
  status: LiminaCheckIssueRuleStatus;
  task: LiminaCheckTaskName;
}

interface LiminaCheckIssueRuleDefinition {
  code: LiminaCheckIssueCode;
  description: string;
  status?: Exclude<LiminaCheckIssueRuleStatus, 'active'>;
  task: LiminaCheckTaskName;
}

const LIMINA_CHECK_ISSUE_RULE_METADATA: Readonly<
  Record<LiminaCheckIssueCode, LiminaCheckIssueRuleDefinition>
> = {
  [LIMINA_CHECK_ISSUE_CODES.checkerBuildFailed]: {
    code: LIMINA_CHECK_ISSUE_CODES.checkerBuildFailed,
    description: 'Checker build execution failed for one or more targets.',
    task: 'checker:build',
  },
  [LIMINA_CHECK_ISSUE_CODES.checkerPeerDependencyMissing]: {
    code: LIMINA_CHECK_ISSUE_CODES.checkerPeerDependencyMissing,
    description: 'A configured checker is missing a required peer dependency.',
    task: 'checker:build',
  },
  [LIMINA_CHECK_ISSUE_CODES.checkerTargetSelectionFailed]: {
    code: LIMINA_CHECK_ISSUE_CODES.checkerTargetSelectionFailed,
    description: 'Limina could not select the checker target to execute.',
    task: 'checker:build',
  },
  [LIMINA_CHECK_ISSUE_CODES.checkerTypecheckFailed]: {
    code: LIMINA_CHECK_ISSUE_CODES.checkerTypecheckFailed,
    description: 'Checker typecheck execution failed for one or more entries.',
    task: 'checker:typecheck',
  },
  [LIMINA_CHECK_ISSUE_CODES.commandFailed]: {
    code: LIMINA_CHECK_ISSUE_CODES.commandFailed,
    description: 'A configured command step exited unsuccessfully.',
    task: 'command',
  },
  [LIMINA_CHECK_ISSUE_CODES.graphAccessDenied]: {
    code: LIMINA_CHECK_ISSUE_CODES.graphAccessDenied,
    description:
      'A graph rule denied an import, reference, or dependency edge.',
    task: 'graph:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.graphCheckFailed]: {
    code: LIMINA_CHECK_ISSUE_CODES.graphCheckFailed,
    description: 'Graph check failed before a more specific rule was recorded.',
    task: 'graph:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.graphConditionDomainMismatch]: {
    code: LIMINA_CHECK_ISSUE_CODES.graphConditionDomainMismatch,
    description: 'Condition domain compiler options do not match their entry.',
    task: 'graph:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid]: {
    code: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
    description: 'Graph configuration contains invalid rule or domain entries.',
    task: 'graph:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.graphImportTargetUnmapped]: {
    code: LIMINA_CHECK_ISSUE_CODES.graphImportTargetUnmapped,
    description:
      'A governed import target is not mapped into the source graph.',
    task: 'graph:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.graphMaterializeFailed]: {
    code: LIMINA_CHECK_ISSUE_CODES.graphMaterializeFailed,
    description: 'Generated graph artifacts could not be materialized.',
    task: 'graph:materialize',
  },
  [LIMINA_CHECK_ISSUE_CODES.graphPrepareFailed]: {
    code: LIMINA_CHECK_ISSUE_CODES.graphPrepareFailed,
    description: 'Generated graph preparation failed.',
    task: 'graph:prepare',
  },
  [LIMINA_CHECK_ISSUE_CODES.graphReferenceCycle]: {
    code: LIMINA_CHECK_ISSUE_CODES.graphReferenceCycle,
    description: 'Generated TypeScript project references contain a cycle.',
    task: 'graph:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.graphReferenceExtra]: {
    code: LIMINA_CHECK_ISSUE_CODES.graphReferenceExtra,
    description:
      'A TypeScript project reference exists without a matching source edge.',
    task: 'graph:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.graphReferenceMissing]: {
    code: LIMINA_CHECK_ISSUE_CODES.graphReferenceMissing,
    description: 'A required TypeScript project reference is missing.',
    task: 'graph:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.graphTargetUnreachable]: {
    code: LIMINA_CHECK_ISSUE_CODES.graphTargetUnreachable,
    description:
      'An expected graph target is not reachable from checker entries.',
    task: 'graph:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.graphWorkspaceDependencyUndeclared]: {
    code: LIMINA_CHECK_ISSUE_CODES.graphWorkspaceDependencyUndeclared,
    description:
      'A cross-package source reference lacks a declared dependency.',
    task: 'graph:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.graphWorkspaceImportOutsideGraph]: {
    code: LIMINA_CHECK_ISSUE_CODES.graphWorkspaceImportOutsideGraph,
    description:
      'A workspace source import resolves outside governed graph coverage.',
    task: 'graph:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.graphWorkspaceImportUnresolved]: {
    code: LIMINA_CHECK_ISSUE_CODES.graphWorkspaceImportUnresolved,
    description: 'A workspace source import could not be resolved.',
    task: 'graph:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.graphWorkspacePackageNameMissing]: {
    code: LIMINA_CHECK_ISSUE_CODES.graphWorkspacePackageNameMissing,
    description:
      'A workspace package in the graph is missing a package identity.',
    task: 'graph:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.packageAttw]: {
    code: LIMINA_CHECK_ISSUE_CODES.packageAttw,
    description:
      'Are The Types Wrong reported a package type-resolution issue.',
    task: 'package:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.packageBoundary]: {
    code: LIMINA_CHECK_ISSUE_CODES.packageBoundary,
    description: 'A package boundary or export rule was violated.',
    task: 'package:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.packageCheckFailed]: {
    code: LIMINA_CHECK_ISSUE_CODES.packageCheckFailed,
    description:
      'Package check failed before a more specific rule was recorded.',
    task: 'package:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.packageManifestInvalid]: {
    code: LIMINA_CHECK_ISSUE_CODES.packageManifestInvalid,
    description: 'A package manifest is invalid for package checking.',
    task: 'package:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.packagePublint]: {
    code: LIMINA_CHECK_ISSUE_CODES.packagePublint,
    description: 'Publint reported a package publishing issue.',
    task: 'package:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.pipelineCommandFailed]: {
    code: LIMINA_CHECK_ISSUE_CODES.pipelineCommandFailed,
    description:
      'Deprecated legacy alias for command failures; new issues use LIMINA_COMMAND_FAILED.',
    status: 'retired',
    task: 'command',
  },
  [LIMINA_CHECK_ISSUE_CODES.proofAllowlistInvalid]: {
    code: LIMINA_CHECK_ISSUE_CODES.proofAllowlistInvalid,
    description: 'Proof check allowlist configuration is invalid.',
    task: 'proof:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid]: {
    code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
    description: 'Checker coverage metadata is invalid for proof checking.',
    task: 'proof:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.proofCheckFailed]: {
    code: LIMINA_CHECK_ISSUE_CODES.proofCheckFailed,
    description: 'Proof check failed before a more specific rule was recorded.',
    task: 'proof:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.proofDefaultTsconfigInvalid]: {
    code: LIMINA_CHECK_ISSUE_CODES.proofDefaultTsconfigInvalid,
    description:
      'A default tsconfig does not satisfy proof-check requirements.',
    task: 'proof:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.proofDuplicateGraphCoverage]: {
    code: LIMINA_CHECK_ISSUE_CODES.proofDuplicateGraphCoverage,
    description:
      'A declaration-emitting source file is covered by multiple generated dts graph entries.',
    task: 'proof:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.proofDuplicateSourceOwner]: {
    code: LIMINA_CHECK_ISSUE_CODES.proofDuplicateSourceOwner,
    description:
      'An implementation source file is owned by multiple ordinary typecheck configs.',
    task: 'proof:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.proofSourceBoundaryMismatch]: {
    code: LIMINA_CHECK_ISSUE_CODES.proofSourceBoundaryMismatch,
    description: 'Source ownership does not match proof-check boundaries.',
    task: 'proof:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile]: {
    code: LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile,
    description: 'A source file is not covered by any configured checker.',
    task: 'proof:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.releaseCheckFailed]: {
    code: LIMINA_CHECK_ISSUE_CODES.releaseCheckFailed,
    description:
      'Release check failed before a more specific rule was recorded.',
    task: 'release:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.releaseConsistency]: {
    code: LIMINA_CHECK_ISSUE_CODES.releaseConsistency,
    description: 'Release metadata or package output is inconsistent.',
    status: 'planned',
    task: 'release:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.releaseContentHash]: {
    code: LIMINA_CHECK_ISSUE_CODES.releaseContentHash,
    description: 'Release content hash validation failed.',
    task: 'release:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.releasePackedManifest]: {
    code: LIMINA_CHECK_ISSUE_CODES.releasePackedManifest,
    description: 'The packed package manifest is not release-ready.',
    task: 'release:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.releaseRegistry]: {
    code: LIMINA_CHECK_ISSUE_CODES.releaseRegistry,
    description: 'Release registry validation failed.',
    task: 'release:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.releaseTarballHygiene]: {
    code: LIMINA_CHECK_ISSUE_CODES.releaseTarballHygiene,
    description: 'Release tarball contents failed hygiene checks.',
    task: 'release:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceCheckFailed]: {
    code: LIMINA_CHECK_ISSUE_CODES.sourceCheckFailed,
    description:
      'Source check failed before a more specific rule was recorded.',
    task: 'source:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationConfigInvalid]: {
    code: LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationConfigInvalid,
    description: 'Shared ambient declaration configuration is invalid.',
    task: 'source:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationSharedUnauthorized]: {
    code: LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationSharedUnauthorized,
    description:
      'An ambient declaration is consumed by multiple source owners without authorization.',
    task: 'source:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationReferenceUnauthorized]: {
    code: LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationReferenceUnauthorized,
    description:
      'A triple-slash path reference targets an ambient declaration without authorization.',
    task: 'source:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceCrossGovernanceBoundary]: {
    code: LIMINA_CHECK_ISSUE_CODES.sourceCrossGovernanceBoundary,
    description:
      'A current-region source import resolves beyond a stopped or excluded governance boundary.',
    task: 'source:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceImportAuthorityInvalid]: {
    code: LIMINA_CHECK_ISSUE_CODES.sourceImportAuthorityInvalid,
    description: 'Source import authority configuration is invalid.',
    task: 'source:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceKnipBuildScriptUnsupported]: {
    code: LIMINA_CHECK_ISSUE_CODES.sourceKnipBuildScriptUnsupported,
    description: 'A package build script cannot be mapped to source analysis.',
    task: 'source:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceKnipConfigInvalid]: {
    code: LIMINA_CHECK_ISSUE_CODES.sourceKnipConfigInvalid,
    description: 'Knip source-analysis configuration is invalid.',
    task: 'source:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceOwnerInvalid]: {
    code: LIMINA_CHECK_ISSUE_CODES.sourceOwnerInvalid,
    description: 'Source owner configuration or package ownership is invalid.',
    task: 'source:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.sourcePackageImportInvalid]: {
    code: LIMINA_CHECK_ISSUE_CODES.sourcePackageImportInvalid,
    description: 'A source package import resolves to an invalid target.',
    task: 'source:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.sourcePackageImportUnauthorized]: {
    code: LIMINA_CHECK_ISSUE_CODES.sourcePackageImportUnauthorized,
    description:
      'A source import is not authorized by the nearest package owner.',
    task: 'source:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceRelativeImportEscapesScope]: {
    code: LIMINA_CHECK_ISSUE_CODES.sourceRelativeImportEscapesScope,
    description: 'A relative source import escapes its owner scope.',
    task: 'source:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance]: {
    code: LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance,
    description: 'A source tsconfig is missing or outside checker governance.',
    task: 'source:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceUnusedModule]: {
    code: LIMINA_CHECK_ISSUE_CODES.sourceUnusedModule,
    description: 'A source module is not reachable from package entry points.',
    task: 'source:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceUnusedWorkspaceDependency]: {
    code: LIMINA_CHECK_ISSUE_CODES.sourceUnusedWorkspaceDependency,
    description: 'A workspace dependency is not visible to source analysis.',
    task: 'source:check',
  },
  [LIMINA_CHECK_ISSUE_CODES.workspaceRegionOverlap]: {
    code: LIMINA_CHECK_ISSUE_CODES.workspaceRegionOverlap,
    description:
      'A nested pnpm workspace root overlaps a current-region workspace package.',
    task: 'workspace:validate',
  },
  [LIMINA_CHECK_ISSUE_CODES.workspaceValidationFailed]: {
    code: LIMINA_CHECK_ISSUE_CODES.workspaceValidationFailed,
    description: 'Workspace validation failed without a more specific issue.',
    task: 'workspace:validate',
  },
  [LIMINA_CHECK_ISSUE_CODES.workspaceOutputCycle]: {
    code: LIMINA_CHECK_ISSUE_CODES.workspaceOutputCycle,
    description:
      'Workspace descriptor and output visibility does not reach a stable state.',
    task: 'workspace:validate',
  },
  [LIMINA_CHECK_ISSUE_CODES.workspaceOutputRootInvalid]: {
    code: LIMINA_CHECK_ISSUE_CODES.workspaceOutputRootInvalid,
    description:
      'A configured output root overlaps a structural workspace root.',
    task: 'workspace:validate',
  },
  [LIMINA_CHECK_ISSUE_CODES.workspacePackageIdentityConflict]: {
    code: LIMINA_CHECK_ISSUE_CODES.workspacePackageIdentityConflict,
    description:
      'Multiple activated package roots resolve to the same physical directory.',
    task: 'workspace:validate',
  },
};

export type LiminaReadableCheckIssueCode = Exclude<
  LiminaCheckIssueCode,
  typeof LIMINA_CHECK_ISSUE_CODES.releaseConsistency
>;

export type LiminaWritableCheckIssueCode = Exclude<
  LiminaCheckIssueCode,
  | typeof LIMINA_CHECK_ISSUE_CODES.pipelineCommandFailed
  | typeof LIMINA_CHECK_ISSUE_CODES.releaseConsistency
>;

const LIMINA_CHECK_ISSUE_CODE_VALUES: readonly LiminaCheckIssueCode[] =
  Object.values(LIMINA_CHECK_ISSUE_CODES);

const LIMINA_CHECK_ISSUE_CODE_SET: ReadonlySet<string> = new Set(
  LIMINA_CHECK_ISSUE_CODE_VALUES,
);

export function isLiminaCheckIssueCode(
  code: string,
): code is LiminaCheckIssueCode {
  return LIMINA_CHECK_ISSUE_CODE_SET.has(code);
}

export function listLiminaCheckIssueCodes(): readonly LiminaCheckIssueCode[] {
  return [...LIMINA_CHECK_ISSUE_CODE_VALUES].sort();
}

export function isWritableLiminaCheckIssueCode(
  code: string,
): code is LiminaWritableCheckIssueCode {
  return isLiminaCheckIssueCode(code) && getIssueRuleStatus(code) === 'active';
}

export function isReadableLiminaCheckIssueCode(
  code: string,
): code is LiminaReadableCheckIssueCode {
  return isLiminaCheckIssueCode(code) && getIssueRuleStatus(code) !== 'planned';
}

export function getLiminaCheckIssueRuleMetadata(
  code: LiminaCheckIssueCode,
): LiminaCheckIssueRuleMetadata {
  const definition = LIMINA_CHECK_ISSUE_RULE_METADATA[code];

  return {
    code: definition.code,
    description: definition.description,
    status: getIssueRuleStatus(code),
    task: definition.task,
  };
}

export function listLiminaCheckIssueRuleMetadata(): readonly LiminaCheckIssueRuleMetadata[] {
  return LIMINA_CHECK_ISSUE_CODE_VALUES.map((code) =>
    getLiminaCheckIssueRuleMetadata(code),
  ).sort(
    (left, right) =>
      left.task.localeCompare(right.task) ||
      left.code.localeCompare(right.code),
  );
}

function getIssueRuleStatus(
  code: LiminaCheckIssueCode,
): LiminaCheckIssueRuleStatus {
  const definition = LIMINA_CHECK_ISSUE_RULE_METADATA[code];
  return definition.status ?? 'active';
}

export function assertIssueTaskMatchesCode(
  code: LiminaCheckIssueCode,
  task: LiminaCheckTaskName,
): void {
  const expectedTask = getLiminaCheckIssueRuleMetadata(code).task;

  if (task !== expectedTask) {
    throw new Error(
      `Issue code ${code} belongs to ${expectedTask}, not ${task}.`,
    );
  }
}

export function assertWritableLiminaCheckIssueCode(
  code: string,
): asserts code is LiminaWritableCheckIssueCode {
  if (!isLiminaCheckIssueCode(code)) {
    throw new Error(`Unknown canonical Limina issue code: ${code}.`);
  }

  const status = getIssueRuleStatus(code);

  if (status === 'planned') {
    throw new Error(`Planned Limina issue code is not writable: ${code}.`);
  }

  if (status === 'retired') {
    throw new Error(`Retired Limina issue code is read-only: ${code}.`);
  }
}

export const DEFAULT_ISSUE_CODE_BY_TASK: Readonly<
  Record<LiminaCheckTaskName, LiminaWritableCheckIssueCode>
> = {
  'checker:build': LIMINA_CHECK_ISSUE_CODES.checkerBuildFailed,
  'checker:typecheck': LIMINA_CHECK_ISSUE_CODES.checkerTypecheckFailed,
  command: LIMINA_CHECK_ISSUE_CODES.commandFailed,
  'graph:check': LIMINA_CHECK_ISSUE_CODES.graphCheckFailed,
  'graph:materialize': LIMINA_CHECK_ISSUE_CODES.graphMaterializeFailed,
  'graph:prepare': LIMINA_CHECK_ISSUE_CODES.graphPrepareFailed,
  'package:check': LIMINA_CHECK_ISSUE_CODES.packageCheckFailed,
  'proof:check': LIMINA_CHECK_ISSUE_CODES.proofCheckFailed,
  'release:check': LIMINA_CHECK_ISSUE_CODES.releaseCheckFailed,
  'source:check': LIMINA_CHECK_ISSUE_CODES.sourceCheckFailed,
  'workspace:validate': LIMINA_CHECK_ISSUE_CODES.workspaceValidationFailed,
};

export function defaultTaskFailureCode(
  task: LiminaCheckTaskName,
): LiminaWritableCheckIssueCode {
  return DEFAULT_ISSUE_CODE_BY_TASK[task];
}
