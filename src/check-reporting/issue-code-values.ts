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
  sourceAmbientDeclarationConfigInvalid:
    'LIMINA_SOURCE_AMBIENT_DECLARATION_CONFIG_INVALID',
  sourceAmbientDeclarationReferenceUnauthorized:
    'LIMINA_SOURCE_AMBIENT_DECLARATION_REFERENCE_UNAUTHORIZED',
  sourceAmbientDeclarationSharedUnauthorized:
    'LIMINA_SOURCE_AMBIENT_DECLARATION_SHARED_UNAUTHORIZED',
  sourceCheckFailed: 'LIMINA_SOURCE_CHECK_FAILED',
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
  sourceResourceModuleNotFound: 'LIMINA_SOURCE_RESOURCE_MODULE_NOT_FOUND',
  sourceResourceModuleTypeUndeclared:
    'LIMINA_SOURCE_RESOURCE_MODULE_TYPE_UNDECLARED',
  sourceTsconfigGovernance: 'LIMINA_SOURCE_TSCONFIG_GOVERNANCE',
  sourceUnusedModule: 'LIMINA_SOURCE_UNUSED_MODULE',
  sourceUnusedWorkspaceDependency: 'LIMINA_SOURCE_UNUSED_WORKSPACE_DEPENDENCY',
  workspaceOutputCycle: 'LIMINA_WORKSPACE_OUTPUT_CYCLE',
  workspaceOutputRootInvalid: 'LIMINA_WORKSPACE_OUTPUT_ROOT_INVALID',
  workspacePackageIdentityConflict:
    'LIMINA_WORKSPACE_PACKAGE_IDENTITY_CONFLICT',
  workspaceRegionOverlap: 'LIMINA_WORKSPACE_REGION_OVERLAP',
  workspaceValidationFailed: 'LIMINA_WORKSPACE_VALIDATION_FAILED',
} as const;

export type LiminaCheckIssueCode =
  (typeof LIMINA_CHECK_ISSUE_CODES)[keyof typeof LIMINA_CHECK_ISSUE_CODES];
