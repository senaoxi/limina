import type { ResolvedCheckerConfig } from '#config/runner';
import { uniqueCodeUnitSortedStrings as uniqueSortedStrings } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import type { ArtifactPlan } from '../../domain/artifacts/plan';
import type { CheckerOwnershipPlan } from './checker-ownership-types';
import {
  resolveGeneratedKnipPackageConfigs,
  resolveGeneratedKnipPackageDiagnostics,
} from './generated-knip';
import type {
  GeneratedBuildModule,
  GeneratedBuildModuleManifest,
  GeneratedOutputDeclarationCopyContext,
  GeneratedTsconfigGraphManifest,
  GeneratedTsconfigGraphResult,
  GovernedSourceUnit,
} from './types';

function toAbsolutePath(rootDir: string, relativePath: string): string {
  return normalizeAbsolutePath(path.join(rootDir, relativePath));
}

function createBuildModuleMap(options: {
  modules: Record<string, GeneratedBuildModuleManifest>;
  rootDir: string;
}): Map<string, GeneratedBuildModule> {
  return new Map(
    Object.entries(options.modules).map(([sourcePath, buildModule]) => [
      toAbsolutePath(options.rootDir, sourcePath),
      {
        kind: buildModule.kind,
        path: toAbsolutePath(options.rootDir, buildModule.path),
      },
    ]),
  );
}

function createAbsoluteStringMap(options: {
  rootDir: string;
  values: Record<string, string>;
}): Map<string, string> {
  return new Map(
    Object.entries(options.values).map(([key, value]) => [
      toAbsolutePath(options.rootDir, key),
      toAbsolutePath(options.rootDir, value),
    ]),
  );
}

interface ResultMaps {
  checkerEntries: Map<string, string>;
  configToOutputBuild: Map<string, Map<string, GeneratedBuildModule>>;
  dtsToSource: Map<string, Map<string, string>>;
  sourceToBuild: Map<string, Map<string, GeneratedBuildModule>>;
  sourceToDts: Map<string, Map<string, string>>;
}

function createEmptyResultMaps(): ResultMaps {
  return {
    checkerEntries: new Map(),
    configToOutputBuild: new Map(),
    dtsToSource: new Map(),
    sourceToBuild: new Map(),
    sourceToDts: new Map(),
  };
}

function addCheckerResultMaps(options: {
  checkerManifest: GeneratedTsconfigGraphManifest['checkers'][string];
  checkerName: string;
  maps: ResultMaps;
  rootDir: string;
}): void {
  options.maps.checkerEntries.set(
    options.checkerName,
    toAbsolutePath(options.rootDir, options.checkerManifest.entry),
  );
  options.maps.configToOutputBuild.set(
    options.checkerName,
    createBuildModuleMap({
      modules: options.checkerManifest.configToOutputBuild,
      rootDir: options.rootDir,
    }),
  );
  options.maps.sourceToBuild.set(
    options.checkerName,
    createBuildModuleMap({
      modules: options.checkerManifest.sourceToBuild,
      rootDir: options.rootDir,
    }),
  );
  options.maps.sourceToDts.set(
    options.checkerName,
    createAbsoluteStringMap({
      rootDir: options.rootDir,
      values: options.checkerManifest.sourceToDts,
    }),
  );
  options.maps.dtsToSource.set(
    options.checkerName,
    createAbsoluteStringMap({
      rootDir: options.rootDir,
      values: options.checkerManifest.dtsToSource,
    }),
  );
}

function createResultMaps(options: {
  manifest: GeneratedTsconfigGraphManifest;
  rootDir: string;
}): ResultMaps {
  const maps = createEmptyResultMaps();
  for (const [checkerName, checkerManifest] of Object.entries(
    options.manifest.checkers,
  )) {
    addCheckerResultMaps({
      checkerManifest,
      checkerName,
      maps,
      rootDir: options.rootDir,
    });
  }
  return maps;
}

function createDependencyEdges(options: {
  manifest: GeneratedTsconfigGraphManifest;
  rootDir: string;
}): GeneratedTsconfigGraphResult['dependencyEdges'] {
  return options.manifest.dependencyEdges.map((edge) => {
    const base = {
      file: edge.file,
      fromChecker: edge.fromChecker,
      fromConfigPath: toAbsolutePath(options.rootDir, edge.fromConfig),
      importedSpecifier: edge.importedSpecifier,
      resolvedFilePath: toAbsolutePath(options.rootDir, edge.resolvedFile),
      toChecker: edge.toChecker,
      toConfigPath: toAbsolutePath(options.rootDir, edge.toConfig),
    };
    return edge.kind === 'declaration-provider'
      ? { ...base, cacheReuse: edge.cacheReuse, kind: edge.kind }
      : { ...base, kind: edge.kind };
  });
}

function cloneOutputDeclarationCopies(
  copiesByChecker: Map<
    string,
    Map<string, GeneratedOutputDeclarationCopyContext[]>
  >,
): GeneratedTsconfigGraphResult['outputDeclarationCopies'] {
  return new Map(
    [...copiesByChecker.entries()].map(
      ([checkerName, copyContextsBySourcePath]) => [
        checkerName,
        new Map(
          [...copyContextsBySourcePath.entries()].map(
            ([sourceConfigPath, copyContexts]) => [
              sourceConfigPath,
              copyContexts.map((copyContext) => ({ ...copyContext })),
            ],
          ),
        ),
      ],
    ),
  );
}

function cloneGovernedSource(unit: GovernedSourceUnit): GovernedSourceUnit {
  return {
    ...unit,
    buildProjection: { ...unit.buildProjection },
    context: {
      checkerPresets: [...unit.context.checkerPresets],
      extensions: [...unit.context.extensions],
      vueSemanticIdentity: unit.context.vueSemanticIdentity,
    },
    declarationFileNames: [...unit.declarationFileNames],
    declarationReferences: new Set(unit.declarationReferences),
    frameworkCapabilities: unit.frameworkCapabilities.map((capability) => ({
      ...capability,
    })),
    ownedFileNames: [...unit.ownedFileNames],
  };
}

function createGovernedSourceMap(
  governedSourcesByChecker: ReadonlyMap<string, readonly GovernedSourceUnit[]>,
): GeneratedTsconfigGraphResult['governedSources'] {
  return new Map(
    [...governedSourcesByChecker].map(([checkerName, units]) => [
      checkerName,
      new Map(
        units.map((unit) => [unit.configPath, cloneGovernedSource(unit)]),
      ),
    ]),
  );
}

export function createResult(options: {
  artifactPlan: ArtifactPlan;
  changed: boolean;
  checkers: ResolvedCheckerConfig[];
  generatedFiles: ReadonlyMap<string, string>;
  governedSourcesByChecker: ReadonlyMap<string, readonly GovernedSourceUnit[]>;
  manifest: GeneratedTsconfigGraphManifest;
  manifestPath: string;
  outputDeclarationCopiesByChecker: Map<
    string,
    Map<string, GeneratedOutputDeclarationCopyContext[]>
  >;
  ownershipPlan: CheckerOwnershipPlan;
  rootDir: string;
}): GeneratedTsconfigGraphResult {
  const maps = createResultMaps(options);
  return {
    artifactPlan: options.artifactPlan,
    changed: options.changed,
    checkers: options.checkers,
    manifestPath: options.manifestPath,
    checkerEntries: maps.checkerEntries,
    configToOutputBuild: maps.configToOutputBuild,
    outputDeclarationCopies: cloneOutputDeclarationCopies(
      options.outputDeclarationCopiesByChecker,
    ),
    sourceToBuild: maps.sourceToBuild,
    sourceToDts: maps.sourceToDts,
    dtsToSource: maps.dtsToSource,
    generatedKnipConfigs: resolveGeneratedKnipPackageConfigs({
      configs: options.manifest.knip.packages,
      rootDir: options.rootDir,
    }),
    generatedKnipDiagnostics: resolveGeneratedKnipPackageDiagnostics({
      diagnostics: options.manifest.knip.diagnostics,
      rootDir: options.rootDir,
    }),
    governedSources: createGovernedSourceMap(options.governedSourcesByChecker),
    dependencyEdges: createDependencyEdges(options),
    manifest: options.manifest,
    ownershipPlan: options.ownershipPlan,
    generatedFiles: new Map(options.generatedFiles),
  };
}

export function collectGeneratedSourceConfigPaths(
  generatedGraph: GeneratedTsconfigGraphResult,
): string[] {
  return uniqueSortedStrings(
    [...generatedGraph.sourceToBuild.values()].flatMap((sourceToBuild) => [
      ...sourceToBuild.keys(),
    ]),
  );
}

export function collectGovernedSourceConfigPaths(
  generatedGraph: GeneratedTsconfigGraphResult,
): string[] {
  return uniqueSortedStrings(
    [...generatedGraph.governedSources.values()].flatMap((governedSources) => [
      ...governedSources.keys(),
    ]),
  );
}
