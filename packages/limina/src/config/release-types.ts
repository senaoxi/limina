export interface ReleaseContentHashConfigArguments {
  dependencyName: string;
  importerName: string;
}

export interface ReleaseContentHashConfig {
  baselineTag?:
    | string
    | ((arguments_: ReleaseContentHashConfigArguments) => string);
  builtinIgnore?: boolean;
  ignore?:
    | string[]
    | ((arguments_: ReleaseContentHashConfigArguments) => string[] | undefined);
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
