import type {
  ReleaseNpmPackageJsonLintConfig,
  ReleaseNpmPackageJsonLintRuleConfig,
} from '#config/runner';
import { LiminaOptionalToolMissingError } from '../execution/tools';

export interface PackedManifestLintIssue {
  lintId: string;
  lintMessage: string;
  node: string;
  severity: string;
}

interface NpmPackageJsonLintResult {
  issues: PackedManifestLintIssue[];
}

interface NpmPackageJsonLintOutput {
  results: NpmPackageJsonLintResult[];
}

interface NpmPackageJsonLintInstance {
  lint: () => NpmPackageJsonLintOutput;
}

type NpmPackageJsonLintConstructor = new (options: {
  config: {
    rules: Record<string, ReleaseNpmPackageJsonLintRuleConfig>;
  };
  cwd: string;
  packageJsonFilePath: string;
  packageJsonObject: unknown;
}) => NpmPackageJsonLintInstance;

interface NpmPackageJsonLintModule {
  default?: {
    NpmPackageJsonLint?: NpmPackageJsonLintConstructor;
  };
  NpmPackageJsonLint?: NpmPackageJsonLintConstructor;
}

const DEFAULT_PACKED_MANIFEST_LINT_RULES = {
  'bin-type': 'error',
  'bundledDependencies-type': 'error',
  'config-type': 'error',
  'cpu-type': 'error',
  'dependencies-type': 'error',
  'description-type': 'error',
  'devDependencies-type': 'error',
  'directories-type': 'error',
  'engines-type': 'error',
  'files-type': 'error',
  'homepage-type': 'error',
  'keywords-type': 'error',
  'license-type': 'error',
  'main-type': 'error',
  'man-type': 'error',
  'name-format': 'error',
  'name-type': 'error',
  'no-archive-dependencies': 'error',
  'no-archive-devDependencies': 'error',
  'no-file-dependencies': 'error',
  'no-file-devDependencies': 'error',
  'no-git-dependencies': 'error',
  'no-git-devDependencies': 'error',
  'no-repeated-dependencies': 'error',
  'optionalDependencies-type': 'error',
  'os-type': 'error',
  'peerDependencies-type': 'error',
  'preferGlobal-type': 'error',
  'private-type': 'error',
  'repository-type': 'error',
  'require-license': 'error',
  'require-name': 'error',
  'require-types': 'error',
  'require-version': 'error',
  'scripts-type': 'error',
  'type-type': 'error',
  'valid-values-private': ['error', [false]],
  'version-format': 'error',
  'version-type': 'error',
} as const satisfies Record<string, ReleaseNpmPackageJsonLintRuleConfig>;

async function loadNpmPackageJsonLintPeer(): Promise<NpmPackageJsonLintConstructor> {
  let lintModule: NpmPackageJsonLintModule;

  try {
    lintModule = (await import(
      'npm-package-json-lint'
    )) as NpmPackageJsonLintModule;
  } catch (error) {
    throw new LiminaOptionalToolMissingError({
      command: 'release check',
      error,
      packageName: 'npm-package-json-lint',
      reason:
        'release.npmPackageJsonLint is enabled and Limina delegates packed manifest linting to npm-package-json-lint.',
    });
  }

  const NpmPackageJsonLint =
    lintModule.NpmPackageJsonLint ?? lintModule.default?.NpmPackageJsonLint;

  if (typeof NpmPackageJsonLint !== 'function') {
    throw new TypeError(
      'Installed npm-package-json-lint does not expose NpmPackageJsonLint.',
    );
  }

  return NpmPackageJsonLint;
}

export async function lintPackedManifest(options: {
  config: ReleaseNpmPackageJsonLintConfig;
  cwd: string;
  manifest: unknown;
  packageJsonFilePath: string;
}): Promise<PackedManifestLintIssue[]> {
  const NpmPackageJsonLint = await loadNpmPackageJsonLintPeer();
  const lintResult = new NpmPackageJsonLint({
    config: {
      rules: {
        ...DEFAULT_PACKED_MANIFEST_LINT_RULES,
        ...options.config.rules,
      },
    },
    cwd: options.cwd,
    packageJsonFilePath: options.packageJsonFilePath,
    packageJsonObject: options.manifest,
  }).lint();

  return lintResult.results.flatMap((result) => result.issues);
}
