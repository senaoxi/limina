export interface ReleaseContentHashConfigArgs {
  dependencyName: string;
  importerName: string;
}

export interface ReleaseContentHashConfig {
  baselineTag?: string | ((args: ReleaseContentHashConfigArgs) => string);
  builtinIgnore?: boolean;
  ignore?:
    | string[]
    | ((args: ReleaseContentHashConfigArgs) => string[] | undefined);
}

export type ReleaseNpmPackageJsonLintSeverity = 'error' | 'off' | 'warning';
export type ReleaseNpmPackageJsonLintRuleConfig =
  | ReleaseNpmPackageJsonLintSeverity
  | readonly [
      ReleaseNpmPackageJsonLintSeverity,
      readonly unknown[] | Record<string, unknown>,
    ];

export interface ReleaseNpmPackageJsonLintConfig {
  rules?: Record<string, ReleaseNpmPackageJsonLintRuleConfig>;
}

export interface ReleaseConfig {
  contentHash?: ReleaseContentHashConfig;
  npmPackageJsonLint?: boolean | ReleaseNpmPackageJsonLintConfig;
}
