import type { ResolvedLiminaConfig } from '#config/runner';
import type { PackageOwner } from '#core/workspace/actions';
import { toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { CheckCounter } from '../check-reporting/stats';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import type { AmbientDeclarationIndex } from './ambient-declarations';
import { createSourceDiagnosticFinding } from './finding-utils';
import type { SourceFinding } from './findings';

interface OwnerCollection {
  missingOwnerFiles: string[];
  ownerPaths: Map<string, PackageOwner>;
}

interface ProjectOwnerOptions {
  ambientDeclarations: AmbientDeclarationIndex;
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  configPath: string;
  fileNames: string[];
  findings: SourceFinding[];
  role: 'declaration leaf' | 'governed source' | 'typecheck companion';
  workspaceLookup: WorkspaceLookupIndex;
}

function collectFileOwner(options: {
  ambientDeclarations: AmbientDeclarationIndex;
  collection: OwnerCollection;
  fileName: string;
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  if (options.ambientDeclarations.has(options.fileName)) {
    return;
  }

  const owner = options.workspaceLookup.findOwnerForFile(options.fileName);
  if (!owner) {
    options.collection.missingOwnerFiles.push(options.fileName);
    return;
  }

  options.collection.ownerPaths.set(owner.packageJsonPath, owner);
}

function collectProjectOwners(options: ProjectOwnerOptions): OwnerCollection {
  const collection: OwnerCollection = {
    missingOwnerFiles: [],
    ownerPaths: new Map(),
  };

  for (const fileName of options.fileNames) {
    options.checks.add();
    collectFileOwner({
      ambientDeclarations: options.ambientDeclarations,
      collection,
      fileName,
      workspaceLookup: options.workspaceLookup,
    });
  }

  return collection;
}

function formatMissingFiles(
  config: ResolvedLiminaConfig,
  fileNames: string[],
): string[] {
  const visibleFiles = fileNames
    .slice(0, 10)
    .map((fileName) => `    - ${toRelativePath(config.rootDir, fileName)}`);
  const overflow = fileNames.length - 10;

  return overflow > 0
    ? [...visibleFiles, `    ...and ${overflow} more`]
    : visibleFiles;
}

function addMissingOwnerFinding(
  options: ProjectOwnerOptions,
  missingOwnerFiles: string[],
): void {
  if (missingOwnerFiles.length === 0) {
    return;
  }

  const title = 'Source file has no source owner';
  const reason =
    'every source file checked by Limina must be governed by a pnpm workspace source owner.';
  const lines = [
    `${title}:`,
    `  ${options.role}: ${toRelativePath(options.config.rootDir, options.configPath)}`,
    '  files:',
    ...formatMissingFiles(options.config, missingOwnerFiles),
    `  reason: ${reason}`,
  ];

  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourceOwnerInvalid,
      facts: {
        configPath: options.configPath,
        filePaths: missingOwnerFiles,
        kind: 'missing-owner',
        role: options.role,
      },
      filePath: options.configPath,
      lines,
      reason,
      title,
    }),
  );
}

function addMixedOwnerFinding(
  options: ProjectOwnerOptions,
  ownerPaths: Map<string, PackageOwner>,
): void {
  if (ownerPaths.size <= 1) {
    return;
  }

  const title = 'Tsconfig source file set mixes source owners';
  const reason =
    'non-aggregator tsconfig leaves and their companion typecheck configs must stay within one pnpm workspace source owner scope.';
  const ownerManifestPaths = [...ownerPaths.keys()];
  const lines = [
    `${title}:`,
    `  ${options.role}: ${toRelativePath(options.config.rootDir, options.configPath)}`,
    '  source owners:',
    ...ownerManifestPaths.map(
      (packageJsonPath) =>
        `    - ${toRelativePath(options.config.rootDir, packageJsonPath)}`,
    ),
    `  reason: ${reason}`,
  ];

  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance,
      facts: {
        configPath: options.configPath,
        kind: 'config-mixed-owners',
        packageManifestPaths: ownerManifestPaths,
        role: options.role,
      },
      filePath: options.configPath,
      lines,
      reason,
      title,
    }),
  );
}

export function addProjectOwnerProblems(options: ProjectOwnerOptions): void {
  const collection = collectProjectOwners(options);

  addMissingOwnerFinding(options, collection.missingOwnerFiles);
  addMixedOwnerFinding(options, collection.ownerPaths);
}
