import path from 'pathe';

import type { ResolvedLiminaConfig } from '#config/runner';
import type {
  PackageManifest,
  PackageOwner,
  WorkspacePackage,
} from '#core/workspace/actions';
import { isNamedWorkspacePackage } from '#core/workspace/actions';
import { uniqueSortedStrings } from '#utils/collections';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  normalizeSlashes,
  toRelativePath,
} from '#utils/path';
import { formatUnknownValue, isPlainRecord } from '#utils/values';
import {
  createWorkspaceDependencyKey,
  type WorkspaceDependencyDeclaration,
} from '../core/packages/authority';
import { findOwnerForFile } from '../core/packages/owners';
import {
  formatSourceKnipWorkspaceField,
  type SourceKnipWorkspaceConfigRecord,
} from './knip-routing';
import {
  isInvalidWorkspacePattern,
  normalizeWorkspacePattern,
  toOwnerRelativeEntryPattern,
} from './workspace-patterns';

export interface OwnerSourceModuleSet {
  checkUnusedFiles: boolean;
  files: string[];
  owner: PackageOwner;
}

export interface UnusedModuleConfig {
  entryPatternsByOwnerName: Map<string, string[]>;
  ignoredKeys: Set<string>;
}

export function createPackageDependencyIssueKey(
  packageJsonPath: string,
  dependencyName: string,
): string {
  return `${normalizeAbsolutePath(packageJsonPath)}\0${dependencyName}`;
}

export function collectUnusedDependencyIgnore(options: {
  declarations: WorkspaceDependencyDeclaration[];
  knipWorkspaceConfigs: Map<string, SourceKnipWorkspaceConfigRecord>;
  problems: string[];
  workspacePackages: WorkspacePackage[];
}): Set<string> {
  const ignoredKeys = new Set<string>();
  const workspacePackageNames = new Set(
    options.workspacePackages
      .filter(isNamedWorkspacePackage)
      .map((workspacePackage) => workspacePackage.name),
  );
  const declarationKeys = new Set(
    options.declarations.map((declaration) =>
      createWorkspaceDependencyKey(
        declaration.importer.name,
        declaration.dependencyName,
      ),
    ),
  );

  for (const [importerName, workspaceConfig] of options.knipWorkspaceConfigs) {
    const rawIgnore = workspaceConfig.ignoreDependencies;
    const workspaceField = formatSourceKnipWorkspaceField(importerName);

    if (rawIgnore === undefined) {
      continue;
    }

    if (!Array.isArray(rawIgnore)) {
      options.problems.push(
        [
          'Invalid source Knip dependency ignore config:',
          `  field: ${workspaceField}.ignoreDependencies`,
          `  value: ${formatUnknownValue(rawIgnore)}`,
          '  reason: ignoreDependencies must be an array.',
        ].join('\n'),
      );
      continue;
    }

    for (const [index, entry] of rawIgnore.entries()) {
      const field = `${workspaceField}.ignoreDependencies[${index}]`;

      if (!isPlainRecord(entry)) {
        options.problems.push(
          [
            'Invalid source Knip dependency ignore config:',
            `  field: ${field}`,
            `  value: ${formatUnknownValue(entry)}`,
            '  reason: ignoreDependencies entries must be objects with non-empty dep and reason fields.',
          ].join('\n'),
        );
        continue;
      }

      const dependencyValue = entry.dep;
      const reasonValue = entry.reason;

      if (
        typeof dependencyValue !== 'string' ||
        dependencyValue.trim().length === 0
      ) {
        options.problems.push(
          [
            'Invalid source Knip dependency ignore config:',
            `  field: ${field}.dep`,
            `  value: ${formatUnknownValue(dependencyValue)}`,
            '  reason: dep must be a non-empty workspace package name.',
          ].join('\n'),
        );
        continue;
      }

      if (typeof reasonValue !== 'string' || reasonValue.trim().length === 0) {
        options.problems.push(
          [
            'Invalid source Knip dependency ignore config:',
            `  field: ${field}.reason`,
            `  value: ${formatUnknownValue(reasonValue)}`,
            '  reason: reason must be a non-empty string.',
          ].join('\n'),
        );
        continue;
      }

      const dependencyName = dependencyValue.trim();
      const dependencyKey = createWorkspaceDependencyKey(
        importerName,
        dependencyName,
      );

      if (!workspacePackageNames.has(dependencyName)) {
        options.problems.push(
          [
            'Invalid source Knip dependency ignore config:',
            `  field: ${field}.dep`,
            `  dep: ${dependencyName}`,
            '  reason: dep must name a package from the pnpm workspace.',
          ].join('\n'),
        );
        continue;
      }

      if (!declarationKeys.has(dependencyKey)) {
        options.problems.push(
          [
            'Invalid source Knip dependency ignore config:',
            `  field: ${field}`,
            `  importer: ${importerName}`,
            `  dep: ${dependencyName}`,
            '  reason: ignoreDependencies entries must match a workspace dependency declared by the keyed importer package manifest.',
          ].join('\n'),
        );
        continue;
      }

      ignoredKeys.add(dependencyKey);
    }
  }

  return ignoredKeys;
}

export function createOwnerSourceFileKey(
  ownerName: string,
  filePath: string,
): string {
  return `${ownerName}\0${normalizeAbsolutePath(filePath)}`;
}

function hasProvidedPackageExports(owner: PackageOwner): boolean {
  return Object.hasOwn(owner.manifest, 'exports');
}

function collectManifestEntryTargets(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap(collectManifestEntryTargets);
  }

  if (isPlainRecord(value)) {
    return Object.values(value).flatMap(collectManifestEntryTargets);
  }

  return [];
}

function collectPackageManifestEntryTargets(
  manifest: PackageManifest,
): string[] {
  const targets = new Set<string>();
  const manifestRecord = manifest as Record<string, unknown>;

  for (const value of [
    manifestRecord.exports,
    manifestRecord.main,
    manifestRecord.module,
    manifestRecord.browser,
    manifestRecord.types,
    manifestRecord.typings,
    manifestRecord.bin,
  ]) {
    for (const target of collectManifestEntryTargets(value)) {
      targets.add(target);
    }
  }

  return [...targets].sort();
}

function normalizeManifestTargetPath(value: string): string | null {
  let target = normalizeSlashes(value.trim());

  while (target.startsWith('./')) {
    target = target.slice(2);
  }

  if (
    target.length === 0 ||
    target.includes('*') ||
    target.endsWith('/package.json') ||
    target === 'package.json' ||
    path.isAbsolute(target) ||
    /^[A-Za-z]:[\\/]/u.test(target) ||
    target === '..' ||
    target.startsWith('../') ||
    target.includes('/../') ||
    target.endsWith('/..')
  ) {
    return null;
  }

  return target;
}

function collectSourceCandidatesForManifestTarget(target: string): string[] {
  const candidates = new Set<string>([target]);
  const withoutDist = target.startsWith('dist/') ? target.slice(5) : null;

  if (withoutDist) {
    candidates.add(withoutDist);
  }

  const initialCandidates = [...candidates];

  for (const candidate of initialCandidates) {
    const replacements: string[] = [];

    if (/\.d\.mts$/u.test(candidate)) {
      replacements.push(candidate.replace(/\.d\.mts$/u, '.mts'));
    } else if (/\.d\.cts$/u.test(candidate)) {
      replacements.push(candidate.replace(/\.d\.cts$/u, '.cts'));
    } else if (/\.d\.ts$/u.test(candidate)) {
      replacements.push(candidate.replace(/\.d\.ts$/u, '.ts'));
    } else if (/\.mjs$/u.test(candidate)) {
      replacements.push(candidate.replace(/\.mjs$/u, '.mts'));
    } else if (/\.cjs$/u.test(candidate)) {
      replacements.push(candidate.replace(/\.cjs$/u, '.cts'));
    } else if (/\.jsx$/u.test(candidate)) {
      replacements.push(
        candidate.replace(/\.jsx$/u, '.tsx'),
        candidate.replace(/\.jsx$/u, '.jsx'),
      );
    } else if (/\.js$/u.test(candidate)) {
      replacements.push(
        candidate.replace(/\.js$/u, '.ts'),
        candidate.replace(/\.js$/u, '.tsx'),
        candidate.replace(/\.js$/u, '.js'),
      );
    }

    for (const replacement of replacements) {
      candidates.add(replacement);
    }
  }

  return [...candidates].sort();
}

export function collectManifestSourceEntryPatterns(
  moduleSet: OwnerSourceModuleSet,
): string[] {
  const filesByOwnerRelativePath = new Map(
    moduleSet.files.map((filePath) => [
      normalizeSlashes(toRelativePath(moduleSet.owner.directory, filePath)),
      filePath,
    ]),
  );
  const patterns = new Set<string>();

  for (const rawTarget of collectPackageManifestEntryTargets(
    moduleSet.owner.manifest,
  )) {
    const target = normalizeManifestTargetPath(rawTarget);

    if (!target) {
      continue;
    }

    for (const candidate of collectSourceCandidatesForManifestTarget(target)) {
      if (filesByOwnerRelativePath.has(candidate)) {
        patterns.add(candidate);
      }
    }
  }

  return [...patterns].sort();
}

export function collectOwnerSourceModuleSets(options: {
  owners: PackageOwner[];
  sourceProjectEntries: { fileNames: string[] }[];
}): OwnerSourceModuleSet[] {
  const filesByOwner = new Map<
    string,
    { files: Set<string>; owner: PackageOwner }
  >();

  for (const sourceProjectEntry of options.sourceProjectEntries) {
    for (const fileName of sourceProjectEntry.fileNames) {
      const filePath = normalizeAbsolutePath(fileName);
      const owner = findOwnerForFile(filePath, options.owners);

      if (!owner?.name) {
        continue;
      }

      const ownerFiles = filesByOwner.get(owner.packageJsonPath) ?? {
        files: new Set<string>(),
        owner,
      };

      ownerFiles.files.add(filePath);
      filesByOwner.set(owner.packageJsonPath, ownerFiles);
    }
  }

  return [...filesByOwner.values()]
    .map(({ files, owner }) => ({
      checkUnusedFiles: hasProvidedPackageExports(owner),
      files: [...files].sort((left, right) => left.localeCompare(right)),
      owner,
    }))
    .sort((left, right) =>
      left.owner.packageJsonPath.localeCompare(right.owner.packageJsonPath),
    );
}

export function collectUnusedModuleConfig(options: {
  config: ResolvedLiminaConfig;
  knipWorkspaceConfigs: Map<string, SourceKnipWorkspaceConfigRecord>;
  ownerModuleSets: OwnerSourceModuleSet[];
  problems: string[];
}): UnusedModuleConfig {
  const ignoredKeys = new Set<string>();
  const entryPatternsByOwnerName = new Map<string, string[]>();
  const moduleSetByOwnerName = new Map(
    options.ownerModuleSets.map((moduleSet) => [
      moduleSet.owner.name as string,
      moduleSet,
    ]),
  );
  const moduleFilesByOwnerName = new Map(
    options.ownerModuleSets.map((moduleSet) => [
      moduleSet.owner.name as string,
      new Set(moduleSet.files),
    ]),
  );
  for (const [ownerName, workspaceConfig] of options.knipWorkspaceConfigs) {
    const workspaceField = formatSourceKnipWorkspaceField(ownerName);
    const moduleSet = moduleSetByOwnerName.get(ownerName);
    const rawEntries = workspaceConfig.entry;

    if (rawEntries !== undefined) {
      if (!Array.isArray(rawEntries)) {
        options.problems.push(
          [
            'Invalid source Knip entry config:',
            `  field: ${workspaceField}.entry`,
            `  value: ${formatUnknownValue(rawEntries)}`,
            '  reason: entry must be an array.',
          ].join('\n'),
        );
      } else if (moduleSet) {
        const ownerRelativePatterns =
          entryPatternsByOwnerName.get(ownerName) ?? [];

        for (const [index, entry] of rawEntries.entries()) {
          const field = `${workspaceField}.entry[${index}]`;

          if (!isPlainRecord(entry)) {
            options.problems.push(
              [
                'Invalid source Knip entry config:',
                `  field: ${field}`,
                `  value: ${formatUnknownValue(entry)}`,
                '  reason: entry configs must be objects with non-empty files and reason fields.',
              ].join('\n'),
            );
            continue;
          }

          const filesValue = entry.files;
          const reasonValue = entry.reason;

          if (!Array.isArray(filesValue) || filesValue.length === 0) {
            options.problems.push(
              [
                'Invalid source Knip entry config:',
                `  field: ${field}.files`,
                `  value: ${formatUnknownValue(filesValue)}`,
                '  reason: files must be a non-empty array of workspace-root-relative glob patterns.',
              ].join('\n'),
            );
            continue;
          }

          if (
            typeof reasonValue !== 'string' ||
            reasonValue.trim().length === 0
          ) {
            options.problems.push(
              [
                'Invalid source Knip entry config:',
                `  field: ${field}.reason`,
                `  value: ${formatUnknownValue(reasonValue)}`,
                '  reason: reason must be a non-empty string.',
              ].join('\n'),
            );
            continue;
          }

          for (const [fileIndex, fileValue] of filesValue.entries()) {
            const fileField = `${field}.files[${fileIndex}]`;

            if (
              typeof fileValue !== 'string' ||
              fileValue.trim().length === 0
            ) {
              options.problems.push(
                [
                  'Invalid source Knip entry config:',
                  `  field: ${fileField}`,
                  `  value: ${formatUnknownValue(fileValue)}`,
                  '  reason: file patterns must be non-empty strings.',
                ].join('\n'),
              );
              continue;
            }

            const pattern = normalizeWorkspacePattern(fileValue);

            if (isInvalidWorkspacePattern(pattern)) {
              options.problems.push(
                [
                  'Invalid source Knip entry config:',
                  `  field: ${fileField}`,
                  `  file: ${pattern}`,
                  '  reason: file patterns must be positive workspace-root-relative globs inside the workspace root.',
                ].join('\n'),
              );
              continue;
            }

            const ownerRelativePattern = toOwnerRelativeEntryPattern({
              config: options.config,
              owner: moduleSet.owner,
              pattern,
            });

            if (!ownerRelativePattern) {
              options.problems.push(
                [
                  'Invalid source Knip entry config:',
                  `  field: ${fileField}`,
                  `  package: ${ownerName}`,
                  `  file: ${pattern}`,
                  '  reason: file patterns must stay inside the keyed package directory.',
                ].join('\n'),
              );
              continue;
            }

            ownerRelativePatterns.push(ownerRelativePattern);
          }
        }

        if (ownerRelativePatterns.length > 0) {
          entryPatternsByOwnerName.set(
            ownerName,
            uniqueSortedStrings(ownerRelativePatterns),
          );
        }
      } else {
        options.problems.push(
          [
            'Invalid source Knip entry config:',
            `  field: ${workspaceField}.entry`,
            `  package: ${ownerName}`,
            '  reason: package must own Limina-governed source modules.',
          ].join('\n'),
        );
      }
    }

    const rawIgnore = workspaceConfig.ignoreFiles;

    if (rawIgnore === undefined) {
      continue;
    }

    if (!Array.isArray(rawIgnore)) {
      options.problems.push(
        [
          'Invalid source Knip file ignore config:',
          `  field: ${workspaceField}.ignoreFiles`,
          `  value: ${formatUnknownValue(rawIgnore)}`,
          '  reason: ignoreFiles must be an array.',
        ].join('\n'),
      );
      continue;
    }

    if (!moduleSet) {
      options.problems.push(
        [
          'Invalid source Knip file ignore config:',
          `  field: ${workspaceField}.ignoreFiles`,
          `  package: ${ownerName}`,
          '  reason: package must own Limina-governed source modules.',
        ].join('\n'),
      );
      continue;
    }

    for (const [index, entry] of rawIgnore.entries()) {
      const field = `${workspaceField}.ignoreFiles[${index}]`;

      if (!isPlainRecord(entry)) {
        options.problems.push(
          [
            'Invalid source Knip file ignore config:',
            `  field: ${field}`,
            `  value: ${formatUnknownValue(entry)}`,
            '  reason: ignoreFiles entries must be objects with non-empty file and reason fields.',
          ].join('\n'),
        );
        continue;
      }

      const fileValue = entry.file;
      const reasonValue = entry.reason;

      if (typeof fileValue !== 'string' || fileValue.trim().length === 0) {
        options.problems.push(
          [
            'Invalid source Knip file ignore config:',
            `  field: ${field}.file`,
            `  value: ${formatUnknownValue(fileValue)}`,
            '  reason: file must be a non-empty workspace-root-relative path.',
          ].join('\n'),
        );
        continue;
      }

      if (typeof reasonValue !== 'string' || reasonValue.trim().length === 0) {
        options.problems.push(
          [
            'Invalid source Knip file ignore config:',
            `  field: ${field}.reason`,
            `  value: ${formatUnknownValue(reasonValue)}`,
            '  reason: reason must be a non-empty string.',
          ].join('\n'),
        );
        continue;
      }

      const file = normalizeSlashes(fileValue.trim());

      if (path.isAbsolute(file) || /^[A-Za-z]:[\\/]/u.test(file)) {
        options.problems.push(
          [
            'Invalid source Knip file ignore config:',
            `  field: ${field}.file`,
            `  file: ${file}`,
            '  reason: file must be relative to the workspace root.',
          ].join('\n'),
        );
        continue;
      }

      const filePath = normalizeAbsolutePath(
        path.resolve(options.config.rootDir, file),
      );

      if (!isPathInsideDirectory(filePath, options.config.rootDir)) {
        options.problems.push(
          [
            'Invalid source Knip file ignore config:',
            `  field: ${field}.file`,
            `  file: ${file}`,
            '  reason: file must resolve inside the workspace root.',
          ].join('\n'),
        );
        continue;
      }

      if (!moduleFilesByOwnerName.get(ownerName)?.has(filePath)) {
        options.problems.push(
          [
            'Invalid source Knip file ignore config:',
            `  field: ${field}.file`,
            `  package: ${ownerName}`,
            `  file: ${file}`,
            '  reason: file must belong to the keyed package source module set known to Limina.',
          ].join('\n'),
        );
        continue;
      }

      ignoredKeys.add(createOwnerSourceFileKey(ownerName, filePath));
    }
  }

  return {
    entryPatternsByOwnerName,
    ignoredKeys,
  };
}
