import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import { existsSync } from 'node:fs';
import type {
  CollectGraphProjectPathsResult,
  TsconfigGraphRouteDiagnostic,
} from './action-types';
import {
  isBuildGraphConfigPath,
  isDtsConfigPath,
  readJsonConfigFile,
  validateUserMaintainedLiminaTsconfigMetadata,
} from './config-paths';
import {
  addTsconfigGraphRouteProblem,
  collectReferencePathInfosForConfig,
} from './reference-paths';

interface GraphRouteEntry {
  projectPath: string;
  rawReferencePath: string;
  referrerPath: string;
}

interface GraphRouteState {
  diagnostics: TsconfigGraphRouteDiagnostic[];
  orderedProjects: string[];
  problems: string[];
  queue: GraphRouteEntry[];
  seen: Set<string>;
}

interface GraphRouteOptions {
  rootConfigPath: string;
  rootDir: string;
  virtualFiles?: ReadonlyMap<string, string>;
}

function isAvailableConfig(
  configPath: string,
  virtualFiles: ReadonlyMap<string, string> | undefined,
): boolean {
  if (existsSync(configPath)) {
    return true;
  }
  return virtualFiles?.has(normalizeAbsolutePath(configPath)) === true;
}

function validateUserConfig(
  configPath: string,
  options: GraphRouteOptions,
): void {
  const normalizedPath = normalizeAbsolutePath(configPath);
  if (!isAvailableConfig(normalizedPath, options.virtualFiles)) {
    return;
  }
  validateUserMaintainedLiminaTsconfigMetadata({
    configObject: readJsonConfigFile(
      options.rootDir,
      normalizedPath,
      options.virtualFiles,
    ),
    configPath: normalizedPath,
  });
}

function isGraphRouteConfig(configPath: string): boolean {
  if (isBuildGraphConfigPath(configPath)) {
    return true;
  }
  return isDtsConfigPath(configPath);
}

function addInvalidRootProblem(
  rootConfigPath: string,
  options: GraphRouteOptions,
  state: GraphRouteState,
): void {
  const reason =
    'checker entries should point to a tsconfig*.build.json graph aggregator or a direct tsconfig*.dts.json declaration leaf.';
  addTsconfigGraphRouteProblem({
    detailLines: [
      'Invalid checker entry config:',
      `  config: ${toRelativePath(options.rootDir, rootConfigPath)}`,
      `  reason: ${reason}`,
    ],
    diagnostics: state.diagnostics,
    filePath: rootConfigPath,
    problems: state.problems,
    reason,
    title: 'Invalid checker entry config',
  });
}

function validateRootConfig(
  rootConfigPath: string,
  options: GraphRouteOptions,
  state: GraphRouteState,
): void {
  validateUserConfig(rootConfigPath, options);
  if (!isGraphRouteConfig(rootConfigPath)) {
    addInvalidRootProblem(rootConfigPath, options, state);
  }
  if (isDtsConfigPath(rootConfigPath)) {
    state.seen.add(rootConfigPath);
    state.orderedProjects.push(rootConfigPath);
  }
}

function addMissingReferenceProblem(
  entry: GraphRouteEntry,
  options: GraphRouteOptions,
  state: GraphRouteState,
): void {
  const reason =
    'every project reference reachable from a checker entry must point to an existing tsconfig file or directory with tsconfig.json.';
  addTsconfigGraphRouteProblem({
    detailLines: [
      'Checker entry references a missing tsconfig:',
      `  from: ${toRelativePath(options.rootDir, entry.referrerPath)}`,
      `  reference: ${entry.rawReferencePath}`,
      `  resolved: ${toRelativePath(options.rootDir, entry.projectPath)}`,
      `  reason: ${reason}`,
    ],
    diagnostics: state.diagnostics,
    filePath: entry.projectPath,
    problems: state.problems,
    reason,
    title: 'Checker entry references a missing tsconfig',
  });
}

function addInvalidReferenceProblem(
  entry: GraphRouteEntry,
  options: GraphRouteOptions,
  state: GraphRouteState,
): void {
  const reason =
    'checker entries may only reach tsconfig*.build.json graph aggregators and tsconfig*.dts.json declaration leaves.';
  addTsconfigGraphRouteProblem({
    detailLines: [
      'Invalid checker entry reference:',
      `  from: ${toRelativePath(options.rootDir, entry.referrerPath)}`,
      `  reference: ${entry.rawReferencePath}`,
      `  resolved: ${toRelativePath(options.rootDir, entry.projectPath)}`,
      `  reason: ${reason}`,
    ],
    diagnostics: state.diagnostics,
    filePath: entry.projectPath,
    problems: state.problems,
    reason,
    title: 'Invalid checker entry reference',
  });
}

function enqueueReferences(
  projectPath: string,
  references: readonly { rawPath: string; resolvedPath: string }[],
  state: GraphRouteState,
): void {
  for (const reference of references) {
    if (state.seen.has(reference.resolvedPath)) {
      continue;
    }
    state.seen.add(reference.resolvedPath);
    state.queue.push({
      projectPath: reference.resolvedPath,
      rawReferencePath: reference.rawPath,
      referrerPath: projectPath,
    });
  }
}

function collectProjectReferences(
  projectPath: string,
  options: GraphRouteOptions,
  state: GraphRouteState,
): void {
  const collection = collectReferencePathInfosForConfig(
    options.rootDir,
    projectPath,
    options.virtualFiles,
  );
  state.diagnostics.push(...collection.diagnostics);
  state.problems.push(...collection.problems);
  enqueueReferences(projectPath, collection.references, state);
}

function processRouteEntry(
  entry: GraphRouteEntry,
  options: GraphRouteOptions,
  state: GraphRouteState,
): void {
  if (!isAvailableConfig(entry.projectPath, options.virtualFiles)) {
    addMissingReferenceProblem(entry, options, state);
    return;
  }
  validateUserConfig(entry.projectPath, options);
  if (!isGraphRouteConfig(entry.projectPath)) {
    addInvalidReferenceProblem(entry, options, state);
    return;
  }
  state.orderedProjects.push(entry.projectPath);
  collectProjectReferences(entry.projectPath, options, state);
}

function traverseRouteQueue(
  options: GraphRouteOptions,
  state: GraphRouteState,
): void {
  for (const entry of state.queue) {
    processRouteEntry(entry, options, state);
  }
}

function createRouteState(
  rootConfigPath: string,
  options: GraphRouteOptions,
): GraphRouteState {
  const rootReferences = collectReferencePathInfosForConfig(
    options.rootDir,
    rootConfigPath,
    options.virtualFiles,
  );
  const queue = rootReferences.references.map((reference) => ({
    projectPath: reference.resolvedPath,
    rawReferencePath: reference.rawPath,
    referrerPath: rootConfigPath,
  }));
  return {
    diagnostics: [...rootReferences.diagnostics],
    orderedProjects: [],
    problems: [...rootReferences.problems],
    queue,
    seen: new Set(queue.map((entry) => entry.projectPath)),
  };
}

export function collectGraphProjectRouteFromRoot(
  options: GraphRouteOptions,
): CollectGraphProjectPathsResult {
  const rootConfigPath = normalizeAbsolutePath(options.rootConfigPath);
  const state = createRouteState(rootConfigPath, options);
  validateRootConfig(rootConfigPath, options, state);
  traverseRouteQueue(options, state);
  return {
    diagnostics: state.diagnostics,
    problems: state.problems,
    projectPaths: state.orderedProjects,
  };
}
