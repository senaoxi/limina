export type SourceAmbientDeclarationConfigInvalidFacts =
  | {
      readonly include: readonly string[];
      readonly kind: 'no-matches';
      readonly ruleIdentity: string;
      readonly ruleIndex: number;
    }
  | {
      readonly declarationPath: string;
      readonly kind: 'overlapping-rules';
      readonly matchingRuleIdentities: readonly string[];
      readonly ruleIdentity: string;
      readonly ruleIndex: number;
    }
  | {
      readonly declarationPath: string;
      readonly kind: 'invalid-declaration';
      readonly ruleIdentity: string;
      readonly ruleIndex: number;
      readonly violation:
        | 'managed-output'
        | 'not-ambient-role'
        | 'not-declaration-file'
        | 'public-declaration-entry';
    };

export interface SourceAmbientDeclarationSharedUnauthorizedFacts {
  readonly consumers: readonly {
    readonly configPaths: readonly string[];
    readonly packageManifestPath: string;
    readonly packageName?: string;
  }[];
  readonly declarationPath: string;
  readonly kind: 'shared-across-owners';
  readonly ruleIdentity: string;
  readonly ruleIndex: number;
}

export interface SourceAmbientDeclarationReferenceUnauthorizedFacts {
  readonly declarationPath: string;
  readonly importerPath: string;
  readonly kind: 'triple-slash-path-reference';
  readonly line: number;
  readonly packageManifestPath: string;
  readonly packageName?: string;
  readonly referenceKind: string;
  readonly ruleIdentity: string;
  readonly ruleIndex: number;
}

export interface SourceCrossGovernanceBoundaryFacts {
  readonly boundary: {
    readonly configPath?: string;
    readonly exclusion?: string;
    readonly kind: string;
    readonly rootDir: string;
  };
  readonly importerPath: string;
  readonly kind: 'cross-governance-boundary';
  readonly line: number;
  readonly packageManifestPath: string;
  readonly packageName?: string;
  readonly resolvedTargetPath: string;
  readonly specifier: string;
}

export interface SourceImportAuthorityInvalidFacts {
  readonly field: string;
  readonly grantIndex?: number;
  readonly kind:
    | 'allow-field'
    | 'grant'
    | 'grant-include'
    | 'grant-packages'
    | 'grant-reason'
    | 'root-dependency-grants'
    | 'unknown-owner';
  readonly ownerIdentity?: string;
  readonly packageManifestPath?: string;
  readonly suggestion?: string;
  readonly value?: unknown;
}

export interface SourceKnipBuildScriptUnsupportedFacts {
  readonly command?: string;
  readonly kind: 'unsupported-build-script';
  readonly packageManifestPath: string;
  readonly packageName?: string;
  readonly scriptName?: string;
}

export interface SourceKnipConfigInvalidFacts {
  readonly dependencyName?: string;
  readonly field: string;
  readonly file?: string;
  readonly importerName?: string;
  readonly kind: 'dependency-ignore' | 'entry' | 'file-ignore' | 'workspace';
  readonly packageName?: string;
  readonly value?: unknown;
}

export type SourceOwnerInvalidFacts =
  | {
      readonly configPath: string;
      readonly filePaths: readonly string[];
      readonly kind: 'missing-owner';
      readonly role: 'declaration leaf' | 'typecheck companion';
    }
  | {
      readonly importerPath: string;
      readonly kind: 'outside-activated-region';
      readonly line: number;
      readonly packageManifestPath: string;
      readonly packageName?: string;
      readonly resolvedTargetPath: string;
      readonly specifier: string;
    }
  | {
      readonly filePath: string;
      readonly kind: 'multiple-owners';
      readonly packageManifestPaths: readonly string[];
    };

export type SourcePackageImportInvalidFacts =
  | {
      readonly importerPath: string;
      readonly kind: 'resolved-package-name-missing';
      readonly line: number;
      readonly packageManifestPath: string;
      readonly packageName?: string;
      readonly resolvedPackageManifestPath: string;
      readonly specifier: string;
    }
  | {
      readonly importerPath: string;
      readonly kind: 'specifier-unauthorized' | 'specifier-unresolved';
      readonly line: number;
      readonly packageManifestPath: string;
      readonly packageName?: string;
      readonly specifier: string;
    }
  | {
      readonly importerPath: string;
      readonly kind:
        | 'other-owner-target'
        | 'outside-source-ownership'
        | 'target-escapes-package-scope';
      readonly line: number;
      readonly packageManifestPath: string;
      readonly packageName?: string;
      readonly resolvedTargetPath: string;
      readonly specifier: string;
      readonly targetPackageManifestPath?: string;
      readonly targetPackageName?: string;
    };

export interface SourcePackageImportUnauthorizedFacts {
  readonly authorityManifestPaths: readonly string[];
  readonly authorityReason?: string;
  readonly dependencyName: string;
  readonly dependencySpecifier?: string;
  readonly importerPath: string;
  readonly intermediateDependencyName?: string;
  readonly kind: 'bare-package-import';
  readonly line: number;
  readonly ownerIdentity: string;
  readonly packageManifestPath: string;
  readonly packageName?: string;
  readonly specifier: string;
  readonly workspacePackageName?: string;
}

export interface SourceRelativeImportEscapesScopeFacts {
  readonly importerPath: string;
  readonly kind: 'relative-import';
  readonly line: number;
  readonly packageManifestPath: string;
  readonly packageName?: string;
  readonly packageScopeManifestPath?: string;
  readonly resolvedTargetPath: string;
  readonly specifier: string;
  readonly targetPackageManifestPath?: string;
}

export type SourceResourceTypeEvidenceKind =
  | 'ambient'
  | 'checker-source'
  | 'concrete-declaration'
  | 'missing'
  | 'unsupported-checker';

export interface SourceResourceModuleNotFoundFacts {
  readonly checkedPath?: string;
  readonly checkerName: string;
  readonly configPath: string;
  readonly importerPath: string;
  readonly kind: 'resource-module-not-found';
  readonly line: number;
  readonly specifier: string;
  readonly typeEvidenceKind: SourceResourceTypeEvidenceKind;
}

export interface SourceResourceModuleTypeUndeclaredFacts {
  readonly checkerName: string;
  readonly configPath: string;
  readonly importerPath: string;
  readonly kind: 'resource-module-type-undeclared';
  readonly line: number;
  readonly runtimeAuthority: 'filesystem' | 'oxc' | 'package-export';
  readonly runtimeFilePath: string;
  readonly specifier: string;
  readonly typeEvidenceKind: 'missing';
}

export type SourceTsconfigGovernanceFacts =
  | {
      readonly checkerName: string;
      readonly configPath?: string;
      readonly kind: 'checker-route';
    }
  | {
      readonly configPath: string;
      readonly field: string;
      readonly kind: 'project-label';
      readonly value?: unknown;
    }
  | {
      readonly configPath: string;
      readonly filePaths?: readonly string[];
      readonly kind:
        | 'config-missing-owner'
        | 'config-mixed-owners'
        | 'config-owner-scope';
      readonly packageManifestPaths?: readonly string[];
      readonly role?: 'declaration leaf' | 'typecheck companion';
    }
  | {
      readonly candidateConfigPaths: readonly string[];
      readonly filePath: string;
      readonly kind: 'module-owner-unresolved';
      readonly matchedConfigPaths: readonly string[];
      readonly resolverConfigPath?: string;
      readonly status: 'missing' | 'multiple' | 'unmatched';
    }
  | {
      readonly configPaths: readonly string[];
      readonly filePath: string;
      readonly kind: 'multiple-governance-units';
    };

export interface SourceUnusedModuleFacts {
  readonly filePath: string;
  readonly kind: 'unused-module';
  readonly ownerDirectory: string;
  readonly packageManifestPath: string;
  readonly packageName: string;
}

export interface SourceUnusedWorkspaceDependencyFacts {
  readonly dependencyName: string;
  readonly kind: 'unused-workspace-dependency';
  readonly packageManifestPath: string;
  readonly packageName: string;
  readonly sectionName: string;
  readonly specifier: string;
}
