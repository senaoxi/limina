import type { OxcResolverProfileIdentity } from '#core/import-analysis/runner';
import type ts from 'typescript';
import type { WorkspaceExportsResolutionProfile } from './types';

export type TypeScriptProfileFallbackReason =
  | {
      readonly actualVersion: string;
      readonly kind: 'unsupported-runtime-version';
    }
  | {
      readonly helpers: readonly string[];
      readonly kind: 'missing-runtime-helper';
    }
  | {
      readonly kind: 'unclassified-compiler-option';
      readonly optionNames: readonly string[];
    }
  | {
      readonly kind: 'unresolved-config-relative-path';
      readonly optionNames: readonly string[];
    };

export type TypeScriptWorkspaceExportProfileKey =
  | readonly ['fallback-only-v1', extensions: readonly string[]]
  | readonly [
      'native-v1',
      effectiveAllowJs: boolean,
      effectiveModuleResolution: ts.ModuleResolutionKind,
      effectiveResolveJsonModule: boolean,
      effectiveResolvePackageJsonExports: boolean,
      baseUrl: string | null,
      pathsBasePath: string | null,
      paths: readonly (readonly [
        pattern: string,
        targets: readonly string[],
      ])[],
      moduleSuffixes: readonly string[],
      customConditions: readonly string[],
      preserveSymlinks: boolean,
      noDtsResolution: boolean,
      extensions: readonly string[],
      typeRoots: readonly string[] | null,
    ]
  | readonly [
      'singleton-fallback-v1',
      originalIndex: number,
      originalConfigPath: string,
    ];

export interface CompiledWorkspaceExportResolutionProfile {
  readonly original: WorkspaceExportsResolutionProfile;
  readonly originalConfigPath: string;
  readonly originalIndex: number;
  readonly oxcProfileId: string;
  readonly typescriptFallbackReason: TypeScriptProfileFallbackReason | null;
  readonly typescriptProfileId: string;
}

export interface TypeScriptResolverPlan {
  readonly id: string;
  readonly key: TypeScriptWorkspaceExportProfileKey;
  readonly memberIndexes: readonly number[];
  readonly representativeIndex: number;
}

export interface OxcResolverPlan
  extends Omit<OxcResolverProfileIdentity, 'id'> {
  readonly id: string;
  readonly memberIndexes: readonly number[];
  readonly representativeIndex: number;
}

export interface WorkspaceExportResolutionGroups {
  readonly byConfigPath: ReadonlyMap<
    string,
    CompiledWorkspaceExportResolutionProfile
  >;
  readonly compiledOriginals: readonly CompiledWorkspaceExportResolutionProfile[];
  readonly originals: readonly WorkspaceExportsResolutionProfile[];
  readonly oxcGroups: ReadonlyMap<string, OxcResolverPlan>;
  readonly typescriptGroups: ReadonlyMap<string, TypeScriptResolverPlan>;
}

export interface TypeScriptResolutionSemanticsAdapter {
  readonly auditedRuntimeVersion: '6.0.3';
  compile(options: ts.CompilerOptions):
    | {
        readonly effectiveAllowJs: boolean;
        readonly effectiveModuleResolution: ts.ModuleResolutionKind;
        readonly effectiveResolveJsonModule: boolean;
        readonly effectiveResolvePackageJsonExports: boolean;
      }
    | {
        readonly fallbackReason: TypeScriptProfileFallbackReason;
      };
}

export interface WorkspaceExportSelfNameContext {
  readonly containingFile: string;
  readonly eligible: boolean;
  readonly failureReason:
    | 'not-a-named-workspace-package'
    | 'missing-exports'
    | 'containing-file-mismatch'
    | 'specifier-is-not-self-name'
    | 'package-scope-unavailable'
    | null;
}

export interface WorkspaceExportSelfNameEntry {
  readonly hasExplicitExports: boolean;
  readonly isNamedWorkspacePackage: boolean;
  readonly packageDirectory: string;
  readonly packageJsonPath: string;
  readonly packageName: string;
  readonly specifier: string;
  readonly subpath: string;
}
