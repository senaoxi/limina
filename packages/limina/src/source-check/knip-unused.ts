import path from 'pathe';

import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
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
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import {
  createSourceKnipConfigFinding,
  type SourceFinding,
  type SourceKnipConfigInvalidFacts,
} from './findings';
import {
  formatSourceKnipWorkspaceField,
  type SourceKnipWorkspaceConfigRecord,
} from './knip-routing';
import {
  isInvalidConfigRootPattern,
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

function addKnipConfigFinding(options: {
  dependencyName?: string;
  details?: readonly string[];
  field: string;
  file?: string;
  findings: SourceFinding[];
  importerName?: string;
  kind: SourceKnipConfigInvalidFacts['kind'];
  packageJsonPath?: string;
  packageName?: string;
  reason: string;
  title: string;
  value?: unknown;
}): void {
  const lines = [
    `${options.title}:`,
    `  field: ${options.field}`,
    ...(options.details ?? []),
    `  reason: ${options.reason}`,
  ];
  options.findings.push(
    createSourceKnipConfigFinding({
      dependencyName: options.dependencyName,
      field: options.field,
      file: options.file,
      importerName: options.importerName,
      kind: options.kind,
      lines,
      packageJsonPath: options.packageJsonPath,
      packageName: options.packageName,
      reason: options.reason,
      title: options.title,
      value: options.value,
    }),
  );
}

export function createPackageDependencyIssueKey(
  packageJsonPath: string,
  dependencyName: string,
): string {
  return `${normalizeAbsolutePath(packageJsonPath)}\0${dependencyName}`;
}

export function collectUnusedDependencyIgnore(options: {
  declarations: WorkspaceDependencyDeclaration[];
  findings: SourceFinding[];
  knipWorkspaceConfigs: Map<string, SourceKnipWorkspaceConfigRecord>;
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
  const packageJsonPathByImporterName = new Map(
    options.workspacePackages
      .filter(isNamedWorkspacePackage)
      .map((entry) => [
        entry.name,
        normalizeAbsolutePath(path.join(entry.directory, 'package.json')),
      ]),
  );

  for (const [importerName, workspaceConfig] of options.knipWorkspaceConfigs) {
    const rawIgnore = workspaceConfig.ignoreDependencies;
    const workspaceField = formatSourceKnipWorkspaceField(importerName);

    if (rawIgnore === undefined) {
      continue;
    }

    if (!Array.isArray(rawIgnore)) {
      addKnipConfigFinding({
        details: [`  value: ${formatUnknownValue(rawIgnore)}`],
        field: `${workspaceField}.ignoreDependencies`,
        findings: options.findings,
        kind: 'dependency-ignore',
        packageJsonPath: packageJsonPathByImporterName.get(importerName),
        packageName: importerName,
        reason: 'ignoreDependencies must be an array.',
        title: 'Invalid source Knip dependency ignore config',
        value: rawIgnore,
      });
      continue;
    }

    for (const [index, entry] of rawIgnore.entries()) {
      const field = `${workspaceField}.ignoreDependencies[${index}]`;

      if (!isPlainRecord(entry)) {
        addKnipConfigFinding({
          details: [`  value: ${formatUnknownValue(entry)}`],
          field,
          findings: options.findings,
          kind: 'dependency-ignore',
          packageJsonPath: packageJsonPathByImporterName.get(importerName),
          packageName: importerName,
          reason:
            'ignoreDependencies entries must be objects with non-empty dep and reason fields.',
          title: 'Invalid source Knip dependency ignore config',
          value: entry,
        });
        continue;
      }

      const dependencyValue = entry.dep;
      const reasonValue = entry.reason;

      if (
        typeof dependencyValue !== 'string' ||
        dependencyValue.trim().length === 0
      ) {
        addKnipConfigFinding({
          details: [`  value: ${formatUnknownValue(dependencyValue)}`],
          field: `${field}.dep`,
          findings: options.findings,
          kind: 'dependency-ignore',
          packageJsonPath: packageJsonPathByImporterName.get(importerName),
          packageName: importerName,
          reason: 'dep must be a non-empty workspace package name.',
          title: 'Invalid source Knip dependency ignore config',
          value: dependencyValue,
        });
        continue;
      }

      if (typeof reasonValue !== 'string' || reasonValue.trim().length === 0) {
        addKnipConfigFinding({
          details: [`  value: ${formatUnknownValue(reasonValue)}`],
          field: `${field}.reason`,
          findings: options.findings,
          kind: 'dependency-ignore',
          packageJsonPath: packageJsonPathByImporterName.get(importerName),
          packageName: importerName,
          reason: 'reason must be a non-empty string.',
          title: 'Invalid source Knip dependency ignore config',
          value: reasonValue,
        });
        continue;
      }

      const dependencyName = dependencyValue.trim();
      const dependencyKey = createWorkspaceDependencyKey(
        importerName,
        dependencyName,
      );

      if (!workspacePackageNames.has(dependencyName)) {
        addKnipConfigFinding({
          dependencyName,
          details: [`  dep: ${dependencyName}`],
          field: `${field}.dep`,
          findings: options.findings,
          kind: 'dependency-ignore',
          packageJsonPath: packageJsonPathByImporterName.get(importerName),
          packageName: importerName,
          reason: 'dep must name a package from the pnpm workspace.',
          title: 'Invalid source Knip dependency ignore config',
        });
        continue;
      }

      if (!declarationKeys.has(dependencyKey)) {
        addKnipConfigFinding({
          dependencyName,
          details: [`  importer: ${importerName}`, `  dep: ${dependencyName}`],
          field,
          findings: options.findings,
          importerName,
          kind: 'dependency-ignore',
          packageJsonPath: packageJsonPathByImporterName.get(importerName),
          packageName: importerName,
          reason:
            'ignoreDependencies entries must match a workspace dependency declared by the keyed importer package manifest.',
          title: 'Invalid source Knip dependency ignore config',
        });
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

export function collectGeneratedArtifactSourceEntryPatterns(options: {
  generatedGraph: GeneratedTsconfigGraphResult;
  moduleSet: OwnerSourceModuleSet;
}): string[] {
  const ownerName = options.moduleSet.owner.name;

  if (!ownerName) {
    return [];
  }

  const sourceFiles = new Set(
    options.moduleSet.files.map(normalizeAbsolutePath),
  );
  const entryTargets = collectPackageManifestEntryTargets(
    options.moduleSet.owner.manifest,
  )
    .map(normalizeManifestTargetPath)
    .filter((target): target is string => target !== null);
  const entryPatterns = new Set<string>();
  const generatedConfig = options.generatedGraph.generatedKnipConfigs.find(
    (candidate) => candidate.packageName === ownerName,
  );

  if (!generatedConfig) {
    return [];
  }

  for (const configPath of collectVirtualProjectConfigs(
    generatedConfig.references,
    options.generatedGraph.generatedFiles,
  )) {
    const content = options.generatedGraph.generatedFiles.get(configPath);

    if (!content) {
      continue;
    }

    const config = JSON.parse(content) as {
      compilerOptions?: { outDir?: unknown; rootDir?: unknown };
    };
    const outDir = resolveConfigDirectory(
      config.compilerOptions?.outDir,
      configPath,
    );
    const rootDir = resolveConfigDirectory(
      config.compilerOptions?.rootDir,
      configPath,
    );

    if (!outDir || !rootDir) {
      continue;
    }

    for (const target of entryTargets) {
      const outputPath = normalizeAbsolutePath(
        path.resolve(options.moduleSet.owner.directory, target),
      );

      if (!isPathInsideDirectory(outputPath, outDir)) {
        continue;
      }

      const relativeOutputPath = normalizeSlashes(
        path.relative(outDir, outputPath),
      );

      for (const candidate of collectSourceCandidatesForManifestTarget(
        relativeOutputPath,
      )) {
        const sourcePath = normalizeAbsolutePath(
          path.resolve(rootDir, candidate),
        );

        if (sourceFiles.has(sourcePath)) {
          entryPatterns.add(
            normalizeSlashes(
              toRelativePath(options.moduleSet.owner.directory, sourcePath),
            ),
          );
        }
      }
    }
  }

  return [...entryPatterns].sort();
}

function collectVirtualProjectConfigs(
  references: readonly string[],
  generatedFiles: ReadonlyMap<string, string>,
): string[] {
  const projects = new Set<string>();
  const visited = new Set<string>();
  const pending = references.map(normalizeAbsolutePath);

  for (const configPath of pending) {
    if (visited.has(configPath)) {
      continue;
    }

    visited.add(configPath);
    const content = generatedFiles.get(configPath);

    if (!content) {
      continue;
    }

    const config = JSON.parse(content) as {
      compilerOptions?: unknown;
      references?: readonly { path?: unknown }[];
    };

    if (isPlainRecord(config.compilerOptions)) {
      projects.add(configPath);
    }

    for (const reference of config.references ?? []) {
      if (typeof reference.path === 'string') {
        pending.push(
          normalizeAbsolutePath(
            path.resolve(path.dirname(configPath), reference.path),
          ),
        );
      }
    }
  }

  return [...projects].sort();
}

function resolveConfigDirectory(
  value: unknown,
  configPath: string,
): string | null {
  return typeof value === 'string'
    ? normalizeAbsolutePath(path.resolve(path.dirname(configPath), value))
    : null;
}

export function collectOwnerSourceModuleSets(options: {
  sourceProjectEntries: { fileNames: string[] }[];
  workspaceLookup: WorkspaceLookupIndex;
}): OwnerSourceModuleSet[] {
  const filesByOwner = new Map<
    string,
    { files: Set<string>; owner: PackageOwner }
  >();

  for (const sourceProjectEntry of options.sourceProjectEntries) {
    for (const fileName of sourceProjectEntry.fileNames) {
      const filePath = normalizeAbsolutePath(fileName);
      const owner = options.workspaceLookup.findOwnerForFile(filePath);

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
  findings: SourceFinding[];
  knipWorkspaceConfigs: Map<string, SourceKnipWorkspaceConfigRecord>;
  ownerModuleSets: OwnerSourceModuleSet[];
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
        addKnipConfigFinding({
          details: [`  value: ${formatUnknownValue(rawEntries)}`],
          field: `${workspaceField}.entry`,
          findings: options.findings,
          kind: 'entry',
          packageJsonPath: moduleSet?.owner.packageJsonPath,
          packageName: ownerName,
          reason: 'entry must be an array.',
          title: 'Invalid source Knip entry config',
          value: rawEntries,
        });
      } else if (moduleSet) {
        const ownerRelativePatterns =
          entryPatternsByOwnerName.get(ownerName) ?? [];

        for (const [index, entry] of rawEntries.entries()) {
          const field = `${workspaceField}.entry[${index}]`;

          if (!isPlainRecord(entry)) {
            addKnipConfigFinding({
              details: [`  value: ${formatUnknownValue(entry)}`],
              field,
              findings: options.findings,
              kind: 'entry',
              packageJsonPath: moduleSet.owner.packageJsonPath,
              packageName: ownerName,
              reason:
                'entry configs must be objects with non-empty files and reason fields.',
              title: 'Invalid source Knip entry config',
              value: entry,
            });
            continue;
          }

          const filesValue = entry.files;
          const reasonValue = entry.reason;

          if (!Array.isArray(filesValue) || filesValue.length === 0) {
            addKnipConfigFinding({
              details: [`  value: ${formatUnknownValue(filesValue)}`],
              field: `${field}.files`,
              findings: options.findings,
              kind: 'entry',
              packageJsonPath: moduleSet.owner.packageJsonPath,
              packageName: ownerName,
              reason:
                'files must be a non-empty array of config-root-relative glob patterns.',
              title: 'Invalid source Knip entry config',
              value: filesValue,
            });
            continue;
          }

          if (
            typeof reasonValue !== 'string' ||
            reasonValue.trim().length === 0
          ) {
            addKnipConfigFinding({
              details: [`  value: ${formatUnknownValue(reasonValue)}`],
              field: `${field}.reason`,
              findings: options.findings,
              kind: 'entry',
              packageJsonPath: moduleSet.owner.packageJsonPath,
              packageName: ownerName,
              reason: 'reason must be a non-empty string.',
              title: 'Invalid source Knip entry config',
              value: reasonValue,
            });
            continue;
          }

          for (const [fileIndex, fileValue] of filesValue.entries()) {
            const fileField = `${field}.files[${fileIndex}]`;

            if (
              typeof fileValue !== 'string' ||
              fileValue.trim().length === 0
            ) {
              addKnipConfigFinding({
                details: [`  value: ${formatUnknownValue(fileValue)}`],
                field: fileField,
                findings: options.findings,
                kind: 'entry',
                packageJsonPath: moduleSet.owner.packageJsonPath,
                packageName: ownerName,
                reason: 'file patterns must be non-empty strings.',
                title: 'Invalid source Knip entry config',
                value: fileValue,
              });
              continue;
            }

            const pattern = normalizeWorkspacePattern(fileValue);

            if (isInvalidConfigRootPattern(pattern)) {
              addKnipConfigFinding({
                details: [`  file: ${pattern}`],
                field: fileField,
                file: pattern,
                findings: options.findings,
                kind: 'entry',
                packageJsonPath: moduleSet.owner.packageJsonPath,
                packageName: ownerName,
                reason:
                  'file patterns must be positive config-root-relative globs.',
                title: 'Invalid source Knip entry config',
              });
              continue;
            }

            const ownerRelativePattern = toOwnerRelativeEntryPattern({
              config: options.config,
              owner: moduleSet.owner,
              pattern,
            });

            if (!ownerRelativePattern) {
              addKnipConfigFinding({
                details: [`  package: ${ownerName}`, `  file: ${pattern}`],
                field: fileField,
                file: pattern,
                findings: options.findings,
                kind: 'entry',
                packageJsonPath: moduleSet.owner.packageJsonPath,
                packageName: ownerName,
                reason:
                  'file patterns must stay inside the keyed package directory.',
                title: 'Invalid source Knip entry config',
              });
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
        addKnipConfigFinding({
          details: [`  package: ${ownerName}`],
          field: `${workspaceField}.entry`,
          findings: options.findings,
          kind: 'entry',
          packageName: ownerName,
          reason: 'package must own Limina-governed source modules.',
          title: 'Invalid source Knip entry config',
        });
      }
    }

    const rawIgnore = workspaceConfig.ignoreFiles;

    if (rawIgnore === undefined) {
      continue;
    }

    if (!Array.isArray(rawIgnore)) {
      addKnipConfigFinding({
        details: [`  value: ${formatUnknownValue(rawIgnore)}`],
        field: `${workspaceField}.ignoreFiles`,
        findings: options.findings,
        kind: 'file-ignore',
        packageJsonPath: moduleSet?.owner.packageJsonPath,
        packageName: ownerName,
        reason: 'ignoreFiles must be an array.',
        title: 'Invalid source Knip file ignore config',
        value: rawIgnore,
      });
      continue;
    }

    if (!moduleSet) {
      addKnipConfigFinding({
        details: [`  package: ${ownerName}`],
        field: `${workspaceField}.ignoreFiles`,
        findings: options.findings,
        kind: 'file-ignore',
        packageName: ownerName,
        reason: 'package must own Limina-governed source modules.',
        title: 'Invalid source Knip file ignore config',
      });
      continue;
    }

    for (const [index, entry] of rawIgnore.entries()) {
      const field = `${workspaceField}.ignoreFiles[${index}]`;

      if (!isPlainRecord(entry)) {
        addKnipConfigFinding({
          details: [`  value: ${formatUnknownValue(entry)}`],
          field,
          findings: options.findings,
          kind: 'file-ignore',
          packageJsonPath: moduleSet.owner.packageJsonPath,
          packageName: ownerName,
          reason:
            'ignoreFiles entries must be objects with non-empty file and reason fields.',
          title: 'Invalid source Knip file ignore config',
          value: entry,
        });
        continue;
      }

      const fileValue = entry.file;
      const reasonValue = entry.reason;

      if (typeof fileValue !== 'string' || fileValue.trim().length === 0) {
        addKnipConfigFinding({
          details: [`  value: ${formatUnknownValue(fileValue)}`],
          field: `${field}.file`,
          findings: options.findings,
          kind: 'file-ignore',
          packageJsonPath: moduleSet.owner.packageJsonPath,
          packageName: ownerName,
          reason: 'file must be a non-empty config-root-relative path.',
          title: 'Invalid source Knip file ignore config',
          value: fileValue,
        });
        continue;
      }

      if (typeof reasonValue !== 'string' || reasonValue.trim().length === 0) {
        addKnipConfigFinding({
          details: [`  value: ${formatUnknownValue(reasonValue)}`],
          field: `${field}.reason`,
          findings: options.findings,
          kind: 'file-ignore',
          packageJsonPath: moduleSet.owner.packageJsonPath,
          packageName: ownerName,
          reason: 'reason must be a non-empty string.',
          title: 'Invalid source Knip file ignore config',
          value: reasonValue,
        });
        continue;
      }

      const file = normalizeSlashes(fileValue.trim());

      if (path.isAbsolute(file) || /^[A-Za-z]:[\\/]/u.test(file)) {
        addKnipConfigFinding({
          details: [`  file: ${file}`],
          field: `${field}.file`,
          file,
          findings: options.findings,
          kind: 'file-ignore',
          packageJsonPath: moduleSet.owner.packageJsonPath,
          packageName: ownerName,
          reason: 'file must be relative to config.rootDir.',
          title: 'Invalid source Knip file ignore config',
        });
        continue;
      }

      const filePath = normalizeAbsolutePath(
        path.resolve(options.config.rootDir, file),
      );

      if (!moduleFilesByOwnerName.get(ownerName)?.has(filePath)) {
        addKnipConfigFinding({
          details: [`  package: ${ownerName}`, `  file: ${file}`],
          field: `${field}.file`,
          file,
          findings: options.findings,
          kind: 'file-ignore',
          packageJsonPath: moduleSet.owner.packageJsonPath,
          packageName: ownerName,
          reason:
            'file must belong to the keyed package source module set known to Limina.',
          title: 'Invalid source Knip file ignore config',
        });
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
