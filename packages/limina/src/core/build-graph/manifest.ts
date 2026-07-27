import type { ResolvedCheckerConfig } from '#config/runner';
import { toPosixPath, toRelativePath } from '#utils/path';
import type {
  GeneratedKnipPackageConfig,
  GeneratedKnipPackageDiagnostic,
} from './generated-knip';
import type {
  GeneratedBuildModule,
  GeneratedBuildModuleManifest,
  GeneratedProviderEdge,
  GeneratedTsconfigGraphManifest,
  SourceProject,
} from './types';

function toManifestPath(rootDir: string, filePath: string): string {
  return toPosixPath(toRelativePath(rootDir, filePath));
}

function createBuildModuleRecord(options: {
  modules: ReadonlyMap<string, GeneratedBuildModule>;
  rootDir: string;
}): Record<string, GeneratedBuildModuleManifest> {
  const record: Record<string, GeneratedBuildModuleManifest> = {};
  for (const [sourceConfigPath, module] of options.modules) {
    record[toManifestPath(options.rootDir, sourceConfigPath)] = {
      kind: module.kind,
      path: toManifestPath(options.rootDir, module.path),
    };
  }
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function createSourceDtsRecords(options: {
  projects: SourceProject[];
  rootDir: string;
}): {
  dtsToSource: Record<string, string>;
  sourceToDts: Record<string, string>;
} {
  const sourceToDts: Record<string, string> = {};
  const dtsToSource: Record<string, string> = {};
  for (const project of options.projects) {
    const sourcePath = toManifestPath(options.rootDir, project.configPath);
    const dtsPath = toManifestPath(options.rootDir, project.dtsConfigPath);
    sourceToDts[sourcePath] = dtsPath;
    dtsToSource[dtsPath] = sourcePath;
  }
  return { dtsToSource, sourceToDts };
}

function getModuleMap(options: {
  checkerName: string;
  modulesByChecker: ReadonlyMap<string, Map<string, GeneratedBuildModule>>;
}): Map<string, GeneratedBuildModule> {
  return options.modulesByChecker.get(options.checkerName) ?? new Map();
}

function createCheckerManifest(options: {
  checker: ResolvedCheckerConfig;
  checkerEntries: ReadonlyMap<string, string>;
  configToOutputBuildByChecker: ReadonlyMap<
    string,
    Map<string, GeneratedBuildModule>
  >;
  projectsByChecker: ReadonlyMap<string, SourceProject[]>;
  rootDir: string;
  sourceToBuildByChecker: ReadonlyMap<
    string,
    Map<string, GeneratedBuildModule>
  >;
}): GeneratedTsconfigGraphManifest['checkers'][string] | null {
  const entryPath = options.checkerEntries.get(options.checker.name);
  if (!entryPath) {
    return null;
  }
  const projects = options.projectsByChecker.get(options.checker.name) ?? [];
  const sourceDtsRecords = createSourceDtsRecords({
    projects,
    rootDir: options.rootDir,
  });
  return {
    configToOutputBuild: createBuildModuleRecord({
      modules: getModuleMap({
        checkerName: options.checker.name,
        modulesByChecker: options.configToOutputBuildByChecker,
      }),
      rootDir: options.rootDir,
    }),
    preset: options.checker.preset,
    entry: toManifestPath(options.rootDir, entryPath),
    roots: projects
      .map((project) => toManifestPath(options.rootDir, project.configPath))
      .sort(),
    sourceToBuild: createBuildModuleRecord({
      modules: getModuleMap({
        checkerName: options.checker.name,
        modulesByChecker: options.sourceToBuildByChecker,
      }),
      rootDir: options.rootDir,
    }),
    sourceToDts: sourceDtsRecords.sourceToDts,
    dtsToSource: sourceDtsRecords.dtsToSource,
  };
}

function createManifestCheckers(options: {
  checkerEntries: ReadonlyMap<string, string>;
  checkers: ResolvedCheckerConfig[];
  configToOutputBuildByChecker: ReadonlyMap<
    string,
    Map<string, GeneratedBuildModule>
  >;
  projectsByChecker: ReadonlyMap<string, SourceProject[]>;
  rootDir: string;
  sourceToBuildByChecker: ReadonlyMap<
    string,
    Map<string, GeneratedBuildModule>
  >;
}): GeneratedTsconfigGraphManifest['checkers'] {
  const manifestCheckers: GeneratedTsconfigGraphManifest['checkers'] = {};
  for (const checker of options.checkers) {
    const manifest = createCheckerManifest({ ...options, checker });
    if (manifest) {
      manifestCheckers[checker.name] = manifest;
    }
  }
  return manifestCheckers;
}

function createProviderEdgeManifest(
  edge: GeneratedProviderEdge,
  rootDir: string,
): GeneratedTsconfigGraphManifest['providerEdges'][number] {
  return {
    file: edge.file,
    fromChecker: edge.fromChecker,
    fromConfig: toManifestPath(rootDir, edge.fromConfigPath),
    importedSpecifier: edge.importedSpecifier,
    resolvedFile: toManifestPath(rootDir, edge.resolvedFilePath),
    toChecker: edge.toChecker,
    toConfig: toManifestPath(rootDir, edge.toConfigPath),
  };
}

export function createManifest(options: {
  checkerEntries: Map<string, string>;
  checkers: ResolvedCheckerConfig[];
  configToOutputBuildByChecker: Map<string, Map<string, GeneratedBuildModule>>;
  generatedKnipDiagnostics: GeneratedKnipPackageDiagnostic[];
  generatedKnipPackageConfigs: GeneratedKnipPackageConfig[];
  ownedArtifacts: string[];
  projectsByChecker: Map<string, SourceProject[]>;
  providerEdges: GeneratedProviderEdge[];
  rootDir: string;
  sourceToBuildByChecker: Map<string, Map<string, GeneratedBuildModule>>;
}): GeneratedTsconfigGraphManifest {
  return {
    version: 3,
    generatedBy: 'limina',
    checkers: createManifestCheckers(options),
    knip: {
      diagnostics: options.generatedKnipDiagnostics,
      packages: options.generatedKnipPackageConfigs,
    },
    ownedArtifacts: options.ownedArtifacts,
    providerEdges: options.providerEdges.map((edge) =>
      createProviderEdgeManifest(edge, options.rootDir),
    ),
  };
}
