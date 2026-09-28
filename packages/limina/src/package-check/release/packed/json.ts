import type { ResolvedLiminaConfig } from '#config/runner';
import path from 'pathe';
import { formatErrorMessage, ReleaseLogger } from '../../../logger';
import {
  lintPackedManifest,
  type PackedManifestLintIssue,
} from '../../packed-manifest-lint';
import {
  addPackedManifestFinding,
  addTarballHygieneFinding,
} from '../consistency/findings';
import type {
  PackedPackageContentFile,
  PublishManifest,
  ReleaseConsistencyState,
} from '../consistency/types';

function getPackageJsonFile(
  contentFiles: readonly PackedPackageContentFile[],
): PackedPackageContentFile | undefined {
  return contentFiles.find((file) => file.relativePath === 'package.json');
}

function addMissingPackageJson(options: {
  packageManifestPath: string;
  rootPackageName: string;
  state: ReleaseConsistencyState;
  tarballPath: string;
}): void {
  addTarballHygieneFinding(options.state, {
    facts: {
      archiveEntryPath: 'package.json',
      kind: 'package-json-missing',
      tarballPath: options.tarballPath,
    },
    filePath: options.packageManifestPath,
    message: `${options.rootPackageName}: tarball does not contain package.json`,
    packageManifestPath: options.packageManifestPath,
    packageName: options.rootPackageName,
  });
}

function addInvalidPackageJson(options: {
  error: unknown;
  packageManifestPath: string;
  rootPackageName: string;
  state: ReleaseConsistencyState;
  tarballPath: string;
}): void {
  const errorMessage = formatErrorMessage(options.error);
  addTarballHygieneFinding(options.state, {
    facts: {
      archiveEntryPath: 'package.json',
      errorMessage,
      kind: 'package-json-invalid',
      tarballPath: options.tarballPath,
    },
    filePath: options.packageManifestPath,
    message: `${options.rootPackageName}: tarball package.json is not valid JSON: ${errorMessage}`,
    packageManifestPath: options.packageManifestPath,
    packageName: options.rootPackageName,
  });
}

export function readPackedPackageJson(options: {
  contentFiles: readonly PackedPackageContentFile[];
  packageManifestPath: string;
  rootPackageName: string;
  state: ReleaseConsistencyState;
  tarballPath: string;
}): PublishManifest | null {
  const packageJsonFile = getPackageJsonFile(options.contentFiles);
  if (packageJsonFile === undefined) {
    addMissingPackageJson(options);
    return null;
  }
  try {
    return JSON.parse(
      Buffer.from(packageJsonFile.data).toString('utf8'),
    ) as PublishManifest;
  } catch (error) {
    addInvalidPackageJson({ ...options, error });
    return null;
  }
}

function formatNpmPackageJsonLintIssue(issue: PackedManifestLintIssue): string {
  return `${issue.lintId} [${issue.node || 'package.json'}]: ${issue.lintMessage}`;
}

function addManifestLintFinding(options: {
  issue: PackedManifestLintIssue;
  packedManifestPath: string;
  packageManifestPath: string;
  rootPackageName: string;
  state: ReleaseConsistencyState;
}): void {
  const message = formatNpmPackageJsonLintIssue(options.issue);
  addPackedManifestFinding(options.state, {
    external: {
      code: options.issue.lintId,
      message: options.issue.lintMessage,
      tool: 'npm-package-json-lint',
    },
    facts: {
      kind: 'manifest-lint-failed',
      lintMessage: options.issue.lintMessage,
      lintNode: options.issue.node || 'package.json',
      lintRule: options.issue.lintId,
      packedManifestPath: options.packedManifestPath,
    },
    filePath: options.packageManifestPath,
    message: `${options.rootPackageName}: ${message}`,
    packageManifestPath: options.packageManifestPath,
    packageName: options.rootPackageName,
    section: 'packed-lint',
    sectionTitle: 'Packed package manifest failed npm-package-json-lint:',
  });
}

function handleManifestLintIssue(options: {
  issue: PackedManifestLintIssue;
  packedManifestPath: string;
  packageManifestPath: string;
  rootPackageName: string;
  state: ReleaseConsistencyState;
}): void {
  const message = formatNpmPackageJsonLintIssue(options.issue);
  if (options.issue.severity === 'warning') {
    ReleaseLogger.warn(
      `[${options.rootPackageName}] [npm-package-json-lint] ${message}`,
    );
    return;
  }
  if (options.issue.severity === 'error') addManifestLintFinding(options);
}

export async function validatePackedManifestLint(options: {
  config: ResolvedLiminaConfig;
  lintConfig: NonNullable<
    NonNullable<ResolvedLiminaConfig['release']>['npmPackageJsonLint']
  >;
  manifest: PublishManifest;
  outDir: string;
  packedManifestPath: string;
  packageManifestPath: string;
  rootPackageName: string;
  state: ReleaseConsistencyState;
}): Promise<void> {
  const issues = await lintPackedManifest({
    config: typeof options.lintConfig === 'object' ? options.lintConfig : {},
    cwd: options.config.rootDir,
    manifest: options.manifest,
    packageJsonFilePath: path.join(options.outDir, 'package.json'),
  });
  for (const issue of issues) handleManifestLintIssue({ ...options, issue });
}
