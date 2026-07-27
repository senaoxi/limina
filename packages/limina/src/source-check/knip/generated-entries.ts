import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  normalizeSlashes,
  toRelativePath,
} from '#utils/path';
import { isPlainRecord } from '#utils/values';
import path from 'pathe';
import {
  collectPackageManifestEntryTargets,
  collectSourceCandidatesForManifestTarget,
  normalizeManifestTargetPath,
} from './manifest-entries';
import type { OwnerSourceModuleSet } from './unused/types';

interface ProjectDirectories {
  outDir: string;
  rootDir: string;
}

function collectReferencePath(options: {
  configPath: string;
  reference: unknown;
}): string[] {
  if (!isPlainRecord(options.reference)) return [];
  if (typeof options.reference.path !== 'string') return [];
  return [
    normalizeAbsolutePath(
      path.resolve(path.dirname(options.configPath), options.reference.path),
    ),
  ];
}

function collectReferencePaths(options: {
  configPath: string;
  references: unknown;
}): string[] {
  if (!Array.isArray(options.references)) return [];
  return options.references.flatMap((reference) =>
    collectReferencePath({ configPath: options.configPath, reference }),
  );
}

function inspectVirtualConfig(options: {
  configPath: string;
  generatedFiles: ReadonlyMap<string, string>;
}): { isProject: boolean; references: string[] } | null {
  const content = options.generatedFiles.get(options.configPath);
  if (content === undefined) return null;
  const config = JSON.parse(content) as {
    compilerOptions?: unknown;
    references?: unknown;
  };
  return {
    isProject: isPlainRecord(config.compilerOptions),
    references: collectReferencePaths({
      configPath: options.configPath,
      references: config.references,
    }),
  };
}

function processVirtualConfig(options: {
  configPath: string;
  generatedFiles: ReadonlyMap<string, string>;
  pending: string[];
  projects: Set<string>;
}): void {
  const inspected = inspectVirtualConfig(options);
  if (inspected === null) return;
  if (inspected.isProject) options.projects.add(options.configPath);
  options.pending.push(...inspected.references);
}

function collectVirtualProjectConfigs(
  references: readonly string[],
  generatedFiles: ReadonlyMap<string, string>,
): string[] {
  const projects = new Set<string>();
  const visited = new Set<string>();
  const pending = references.map(normalizeAbsolutePath);
  for (const configPath of pending) {
    if (visited.has(configPath)) continue;
    visited.add(configPath);
    processVirtualConfig({ configPath, generatedFiles, pending, projects });
  }
  return [...projects].sort();
}

function resolveConfigDirectory(
  value: unknown,
  configPath: string,
): string | null {
  if (typeof value !== 'string') return null;
  return normalizeAbsolutePath(path.resolve(path.dirname(configPath), value));
}

function createProjectDirectories(options: {
  configPath: string;
  outDir: unknown;
  rootDir: unknown;
}): ProjectDirectories | null {
  const outDir = resolveConfigDirectory(options.outDir, options.configPath);
  const rootDir = resolveConfigDirectory(options.rootDir, options.configPath);
  if (outDir === null) return null;
  if (rootDir === null) return null;
  return { outDir, rootDir };
}

function getCompilerDirectoryValues(config: {
  compilerOptions?: { outDir?: unknown; rootDir?: unknown };
}): { outDir: unknown; rootDir: unknown } {
  const compilerOptions = config.compilerOptions;
  if (compilerOptions === undefined) {
    return { outDir: undefined, rootDir: undefined };
  }
  return {
    outDir: compilerOptions.outDir,
    rootDir: compilerOptions.rootDir,
  };
}

function readProjectDirectories(options: {
  configPath: string;
  generatedFiles: ReadonlyMap<string, string>;
}): ProjectDirectories | null {
  const content = options.generatedFiles.get(options.configPath);
  if (content === undefined) return null;
  const config = JSON.parse(content) as {
    compilerOptions?: { outDir?: unknown; rootDir?: unknown };
  };
  const values = getCompilerDirectoryValues(config);
  return createProjectDirectories({
    configPath: options.configPath,
    outDir: values.outDir,
    rootDir: values.rootDir,
  });
}

function collectEntryTargets(moduleSet: OwnerSourceModuleSet): string[] {
  return collectPackageManifestEntryTargets(moduleSet.owner.manifest)
    .map(normalizeManifestTargetPath)
    .filter((target): target is string => target !== null);
}

function collectTargetSourcePatterns(options: {
  directories: ProjectDirectories;
  moduleSet: OwnerSourceModuleSet;
  sourceFiles: ReadonlySet<string>;
  target: string;
}): string[] {
  const outputPath = normalizeAbsolutePath(
    path.resolve(options.moduleSet.owner.directory, options.target),
  );
  if (!isPathInsideDirectory(outputPath, options.directories.outDir)) return [];
  const relativeOutputPath = normalizeSlashes(
    path.relative(options.directories.outDir, outputPath),
  );
  return collectSourceCandidatesForManifestTarget(relativeOutputPath).flatMap(
    (candidate) => {
      const sourcePath = normalizeAbsolutePath(
        path.resolve(options.directories.rootDir, candidate),
      );
      if (!options.sourceFiles.has(sourcePath)) return [];
      return [
        normalizeSlashes(
          toRelativePath(options.moduleSet.owner.directory, sourcePath),
        ),
      ];
    },
  );
}

function collectProjectEntryPatterns(options: {
  directories: ProjectDirectories;
  entryTargets: readonly string[];
  moduleSet: OwnerSourceModuleSet;
  sourceFiles: ReadonlySet<string>;
}): string[] {
  return options.entryTargets.flatMap((target) =>
    collectTargetSourcePatterns({ ...options, target }),
  );
}

function collectConfigPatterns(options: {
  configPath: string;
  entryTargets: readonly string[];
  generatedFiles: ReadonlyMap<string, string>;
  moduleSet: OwnerSourceModuleSet;
  sourceFiles: ReadonlySet<string>;
}): string[] {
  const directories = readProjectDirectories(options);
  if (directories === null) return [];
  return collectProjectEntryPatterns({
    directories,
    entryTargets: options.entryTargets,
    moduleSet: options.moduleSet,
    sourceFiles: options.sourceFiles,
  });
}

function findGeneratedKnipConfig(options: {
  generatedGraph: GeneratedTsconfigGraphResult;
  ownerName: string;
}) {
  return options.generatedGraph.generatedKnipConfigs.find(
    (candidate) => candidate.packageName === options.ownerName,
  );
}

export function collectGeneratedArtifactSourceEntryPatterns(options: {
  generatedGraph: GeneratedTsconfigGraphResult;
  moduleSet: OwnerSourceModuleSet;
}): string[] {
  const ownerName = options.moduleSet.owner.name;
  if (ownerName === undefined) return [];
  const generatedConfig = findGeneratedKnipConfig({
    generatedGraph: options.generatedGraph,
    ownerName,
  });
  if (generatedConfig === undefined) return [];
  const sourceFiles = new Set(
    options.moduleSet.files.map(normalizeAbsolutePath),
  );
  const entryTargets = collectEntryTargets(options.moduleSet);
  const projects = collectVirtualProjectConfigs(
    generatedConfig.references,
    options.generatedGraph.generatedFiles,
  );
  const patterns = projects.flatMap((configPath) =>
    collectConfigPatterns({
      configPath,
      entryTargets,
      generatedFiles: options.generatedGraph.generatedFiles,
      moduleSet: options.moduleSet,
      sourceFiles,
    }),
  );
  return [...new Set(patterns)].sort();
}
