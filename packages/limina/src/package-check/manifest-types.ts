export interface DistPackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  exports?: unknown;
  imports?: Record<string, unknown>;
  name: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  private?: boolean;
}

export interface PackageImportTargetMatch {
  key: string;
  targets: unknown[];
}

export interface SelfSpecifierMatchers {
  exact: Set<string>;
  patterns: {
    prefix: string;
    suffix: string;
  }[];
}
