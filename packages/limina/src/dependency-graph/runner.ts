import type { ResolvedLiminaConfig } from '#config/runner';
import type { AnalysisProviderSet } from '#core';
import { createAnalysisProviders } from '#core';
import type { ProjectInfo } from '#core/import-graph/context';
import {
  collectImportsFromFile,
  createFileOwnerLookup,
  resolveInternalImport,
} from '#core/import-graph/context';
import {
  findPackageForSpecifier,
  isNamedWorkspacePackage,
  type WorkspacePackage,
} from '#core/workspace/actions';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  toRelativePath,
} from '#utils/path';
import path from 'pathe';
import {
  createWorkspaceExportsResolutionIndex,
  type WorkspaceExportsResolutionProfile,
} from '../core/workspace/exports';
import {
  createWorkspaceLookupIndex,
  type WorkspaceLookupIndex,
} from '../core/workspace/lookup';
import { WorkspaceRegionPathIndex } from '../core/workspace/validated-context';

export type DependencyGraphView = 'all' | 'artifact' | 'source';
export type DependencyGraphEdgeKind = 'artifact' | 'source';

export interface DependencyGraphNode {
  id: string;
  kind: 'package';
  name: string;
  path: string;
}

export interface DependencyGraphEvidence {
  importer: string;
  resolvedPath: string;
  specifier: string;
}

export interface DependencyGraphEdge {
  evidence: DependencyGraphEvidence[];
  from: string;
  kind: DependencyGraphEdgeKind;
  to: string;
}

export interface DependencyGraphDocument {
  edges: DependencyGraphEdge[];
  nodes: DependencyGraphNode[];
  rootDir: string;
  schemaVersion: 1;
  view: DependencyGraphView;
}

export interface CollectDependencyGraphOptions {
  providers?: AnalysisProviderSet;
  view?: DependencyGraphView;
}

function filterProjectInfoToActivatedRegion(
  project: ProjectInfo,
  workspaceLookup: WorkspaceLookupIndex,
): ProjectInfo {
  return {
    ...project,
    fileNames: project.fileNames.filter((fileName) =>
      workspaceLookup.isInsideActivatedRegion(fileName),
    ),
    ownedFileNames: project.ownedFileNames.filter((fileName) =>
      workspaceLookup.isInsideActivatedRegion(fileName),
    ),
  };
}

const defaultArtifactDirectories = ['dist'];

function createPackageNodeId(packageName: string): string {
  return `pkg:${packageName}`;
}

function configuredArtifactDirectories(): string[] {
  return defaultArtifactDirectories;
}

function matchesArtifactDirectory(
  targetPackage: WorkspacePackage,
  resolvedPath: string,
): boolean {
  return configuredArtifactDirectories().some((artifactDirectory) => {
    const artifactPath = normalizeAbsolutePath(
      path.join(targetPackage.directory, artifactDirectory),
    );

    return isPathInsideDirectory(resolvedPath, artifactPath);
  });
}

function createWorkspaceExportsResolutionProfiles(
  projects: ProjectInfo[],
): WorkspaceExportsResolutionProfile[] {
  return projects.map((project) => ({
    checkerPresets: project.checkerPresets,
    configPath: project.configPath,
    extensions: project.extensions,
    options: project.options,
    resolverConfigPath: project.resolverConfigPath,
  }));
}

async function collectDependencyGraphProjects(
  core: AnalysisProviderSet,
): Promise<{
  problems: string[];
  projects: ProjectInfo[];
}> {
  return core.tsconfig.getSourceGraphProjects();
}

function normalizeDependencyGraphView(
  view: DependencyGraphView | undefined,
): DependencyGraphView {
  return view ?? 'all';
}

function createNodes(
  config: ResolvedLiminaConfig,
  workspacePackages: WorkspacePackage[],
): DependencyGraphNode[] {
  return workspacePackages
    .filter(isNamedWorkspacePackage)
    .map((workspacePackage) => ({
      id: createPackageNodeId(workspacePackage.name),
      kind: 'package' as const,
      name: workspacePackage.name,
      path: toRelativePath(config.rootDir, workspacePackage.directory),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function addEdge(
  edgesByKey: Map<string, DependencyGraphEdge>,
  edge: Omit<DependencyGraphEdge, 'evidence'> & {
    evidence: DependencyGraphEvidence;
  },
): void {
  const edgeKey = `${edge.kind}\0${edge.from}\0${edge.to}`;
  const currentEdge = edgesByKey.get(edgeKey) ?? {
    evidence: [],
    from: edge.from,
    kind: edge.kind,
    to: edge.to,
  };
  const evidenceKey = `${edge.evidence.importer}\0${edge.evidence.specifier}\0${edge.evidence.resolvedPath}`;

  if (
    !currentEdge.evidence.some(
      (evidence) =>
        `${evidence.importer}\0${evidence.specifier}\0${evidence.resolvedPath}` ===
        evidenceKey,
    )
  ) {
    currentEdge.evidence.push(edge.evidence);
  }

  edgesByKey.set(edgeKey, currentEdge);
}

function sortEdges(edges: DependencyGraphEdge[]): DependencyGraphEdge[] {
  return edges
    .map((edge) => ({
      ...edge,
      evidence: [...edge.evidence].sort((left, right) => {
        const importerOrder = left.importer.localeCompare(right.importer);

        if (importerOrder !== 0) {
          return importerOrder;
        }

        const specifierOrder = left.specifier.localeCompare(right.specifier);

        return specifierOrder === 0
          ? left.resolvedPath.localeCompare(right.resolvedPath)
          : specifierOrder;
      }),
    }))
    .sort((left, right) => {
      const fromOrder = left.from.localeCompare(right.from);

      if (fromOrder !== 0) {
        return fromOrder;
      }

      const toOrder = left.to.localeCompare(right.to);

      return toOrder === 0 ? left.kind.localeCompare(right.kind) : toOrder;
    });
}

function resolveTargetPackage(options: {
  declaredTargetPackage: WorkspacePackage | null;
  graphResolvedFilePath: string | null;
  resolvedFilePath: string;
  workspaceLookup: WorkspaceLookupIndex;
}): WorkspacePackage | null {
  return (
    options.declaredTargetPackage ??
    (options.graphResolvedFilePath
      ? options.workspaceLookup.findPackageForFile(
          options.graphResolvedFilePath,
        )
      : null) ??
    options.workspaceLookup.findPackageForFile(options.resolvedFilePath)
  );
}

function shouldUseWorkspaceExportResolution(options: {
  declaredTargetPackage: WorkspacePackage | null;
  resolvedFilePath: string | null;
}): boolean {
  if (!options.declaredTargetPackage) {
    return false;
  }

  return !options.resolvedFilePath;
}

function classifyEdge(options: {
  fileOwnerLookup: Map<string, string[]>;
  graphResolvedFilePath: string | null;
  resolvedFilePath: string;
  targetPackage: WorkspacePackage;
}): DependencyGraphEdgeKind | null {
  if (
    matchesArtifactDirectory(options.targetPackage, options.resolvedFilePath)
  ) {
    return 'artifact';
  }

  if (
    options.graphResolvedFilePath &&
    options.fileOwnerLookup.has(options.graphResolvedFilePath)
  ) {
    return 'source';
  }

  if (options.fileOwnerLookup.has(options.resolvedFilePath)) {
    return 'source';
  }

  return null;
}

function addNamelessGraphPackageProblem(options: {
  config: ResolvedLiminaConfig;
  importRecord: { filePath: string; specifier: string };
  packageRole: 'importer' | 'target';
  problems: string[];
  resolvedFilePath: string;
  workspacePackage: WorkspacePackage;
}): void {
  options.problems.push(
    [
      'Dependency graph package identity requires package.json name:',
      `  package.json: ${toRelativePath(options.config.rootDir, path.join(options.workspacePackage.directory, 'package.json'))}`,
      `  role: ${options.packageRole}`,
      `  file: ${toRelativePath(options.config.rootDir, options.importRecord.filePath)}`,
      `  imported specifier: ${options.importRecord.specifier}`,
      `  resolved file: ${toRelativePath(options.config.rootDir, options.resolvedFilePath)}`,
      '  reason: dependency graph nodes and edges are keyed by package name; nameless workspace packages can be source owners but cannot appear as dependency graph nodes.',
      '  fix: add a non-empty package.json name when this workspace package should appear in the dependency graph.',
    ].join('\n'),
  );
}

export async function collectDependencyGraph(
  config: ResolvedLiminaConfig,
  options: CollectDependencyGraphOptions = {},
): Promise<DependencyGraphDocument> {
  const core = options.providers ?? createAnalysisProviders(config);
  const view = normalizeDependencyGraphView(options.view);
  const workspaceContext = await core.workspace.getValidatedContext();
  const checkerProjects = await collectDependencyGraphProjects(core);
  const problems = [...checkerProjects.problems];
  const workspacePackages = await core.workspace.getPackages();
  const workspaceLookup = createWorkspaceLookupIndex({
    importers: [],
    owners: [],
    packages: workspacePackages,
    pathIndex: new WorkspaceRegionPathIndex(workspaceContext),
    rootDir: config.rootDir,
  });
  const projects = checkerProjects.projects.map((project) =>
    filterProjectInfoToActivatedRegion(project, workspaceLookup),
  );
  const importAnalysis = core.imports.context;
  const workspaceExports = await createWorkspaceExportsResolutionIndex({
    config,
    importAnalysis,
    packages: workspacePackages,
    profiles: createWorkspaceExportsResolutionProfiles(projects),
  });

  problems.push(...workspaceExports.problems);

  if (problems.length > 0) {
    throw new Error(problems.join('\n\n'));
  }

  const fileOwnerLookup = createFileOwnerLookup(projects);
  const edgesByKey = new Map<string, DependencyGraphEdge>();

  for (const project of projects) {
    for (const fileName of project.ownedFileNames) {
      const importerPackage = workspaceLookup.findPackageForFile(fileName);

      if (!importerPackage) {
        continue;
      }

      for (const importRecord of collectImportsFromFile(
        fileName,
        config.rootDir,
        importAnalysis,
      )) {
        const declaredTargetPackage = findPackageForSpecifier(
          importRecord.specifier,
          workspacePackages,
        );
        const workspaceExportResolution =
          declaredTargetPackage &&
          workspaceExports.hasExports(declaredTargetPackage.name)
            ? workspaceExports.get(project.configPath, importRecord.specifier)
            : null;
        const internalResolvedFilePath = resolveInternalImport(
          importRecord.specifier,
          fileName,
          project.options,
          project,
          importAnalysis,
        );
        const useWorkspaceExportResolution = shouldUseWorkspaceExportResolution(
          {
            declaredTargetPackage,
            resolvedFilePath: internalResolvedFilePath,
          },
        );
        const resolvedFilePath =
          (useWorkspaceExportResolution
            ? workspaceExportResolution?.oxcResolvedFileName
            : null) ?? internalResolvedFilePath;

        if (!resolvedFilePath) {
          continue;
        }

        const graphResolvedFilePath =
          (useWorkspaceExportResolution
            ? workspaceExportResolution?.typeScriptResolvedFileName
            : null) ?? resolvedFilePath;
        const targetPackage = resolveTargetPackage({
          declaredTargetPackage: useWorkspaceExportResolution
            ? declaredTargetPackage
            : null,
          graphResolvedFilePath,
          resolvedFilePath,
          workspaceLookup,
        });

        if (
          !targetPackage ||
          targetPackage.directory === importerPackage.directory
        ) {
          continue;
        }

        const edgeKind = classifyEdge({
          fileOwnerLookup,
          graphResolvedFilePath,
          resolvedFilePath,
          targetPackage,
        });

        if (!edgeKind || (view !== 'all' && view !== edgeKind)) {
          continue;
        }

        if (!isNamedWorkspacePackage(importerPackage)) {
          addNamelessGraphPackageProblem({
            config,
            importRecord,
            packageRole: 'importer',
            problems,
            resolvedFilePath,
            workspacePackage: importerPackage,
          });
          continue;
        }

        if (!isNamedWorkspacePackage(targetPackage)) {
          addNamelessGraphPackageProblem({
            config,
            importRecord,
            packageRole: 'target',
            problems,
            resolvedFilePath,
            workspacePackage: targetPackage,
          });
          continue;
        }

        addEdge(edgesByKey, {
          evidence: {
            importer: toRelativePath(config.rootDir, importRecord.filePath),
            resolvedPath: toRelativePath(config.rootDir, resolvedFilePath),
            specifier: importRecord.specifier,
          },
          from: createPackageNodeId(importerPackage.name),
          kind: edgeKind,
          to: createPackageNodeId(targetPackage.name),
        });
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(problems.join('\n\n'));
  }

  const nodes = createNodes(config, workspacePackages);

  return {
    edges: sortEdges([...edgesByKey.values()]),
    nodes,
    rootDir: '.',
    schemaVersion: 1,
    view,
  };
}

export function stringifyDependencyGraph(
  graph: DependencyGraphDocument,
): string {
  return `${JSON.stringify(graph, null, 2)}\n`;
}
