import { parseCheckerProjectConfigForContext } from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import {
  collectReferencePathInfosForConfig,
  isLiminaSolutionConfig,
  isOrdinarySourceTypecheckConfigPath,
  isTypeScriptSolutionConfig,
  isUnsupportedNamedSolutionConfig,
  readJsonConfig,
} from '#core/tsconfig/actions';
import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { capabilityDiscoveryExtensions } from '../../core/build-graph/generated/file-extensions';
import {
  type ValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../../core/workspace/validated-context';
import {
  collectMigrationEntries,
  createNoMigrationEntryError,
} from './entries';
import {
  createBoundaryError,
  createUnsupportedNamedSolutionError,
} from './errors';
import type {
  MigrationEntry,
  MigrationTarget,
  MigrationTargetCollection,
} from './types';

async function readMigrationTarget(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  planningVirtualFiles: Map<string, string>;
}): Promise<MigrationTarget> {
  const configPath = normalizeAbsolutePath(options.configPath);
  const cached = options.planningVirtualFiles.get(configPath);
  const originalBytes =
    cached === undefined ? await readFile(configPath) : Buffer.from(cached);
  const originalContent = cached ?? originalBytes.toString('utf8');
  options.planningVirtualFiles.set(configPath, originalContent);
  const configObject = readJsonConfig(
    options.config,
    configPath,
    options.planningVirtualFiles,
  );
  const parsed = parseCheckerProjectConfigForContext({
    allowNoInputDiagnostics: true,
    configPath,
    context: {
      checkerPresets: ['tsc'],
      extensions: capabilityDiscoveryExtensions,
    },
    projectRootDir: options.config.rootDir,
    virtualFiles: options.planningVirtualFiles,
  });
  return {
    configObject,
    configPath,
    effectiveConfig: {
      fileNames: parsed.fileNames,
      options: parsed.options,
    },
    isLiminaSolution: isLiminaSolutionConfig({
      configObject,
      configPath,
      fileNames: parsed.fileNames,
    }),
    isTypeScriptSolution: isTypeScriptSolutionConfig({
      configObject,
      configPath,
      fileNames: parsed.fileNames,
    }),
    originalBytes,
    originalContent,
  };
}

function isEligibleReferencePath(
  referencePath: string,
  rootDir: string,
): boolean {
  return (
    existsSync(referencePath) &&
    isOrdinarySourceTypecheckConfigPath(referencePath, rootDir)
  );
}

function validateReferencePath(options: {
  config: ResolvedLiminaConfig;
  pathIndex: WorkspaceRegionPathIndex;
  referencePath: string;
  sourceConfigPath: string;
}): string | null {
  if (!isEligibleReferencePath(options.referencePath, options.config.rootDir)) {
    return null;
  }
  if (!options.pathIndex.isSourceConfigPath(options.referencePath)) {
    throw createBoundaryError(options);
  }
  return options.referencePath;
}

function collectReferenceTargets(options: {
  config: ResolvedLiminaConfig;
  pathIndex: WorkspaceRegionPathIndex;
  planningVirtualFiles: ReadonlyMap<string, string>;
  sourceConfigPath: string;
}): string[] {
  const collection = collectReferencePathInfosForConfig(
    options.config.rootDir,
    options.sourceConfigPath,
    options.planningVirtualFiles,
  );
  if (collection.problems.length > 0) {
    throw new Error(collection.problems.join('\n\n'));
  }
  return collection.references.flatMap((reference) => {
    const referencePath = validateReferencePath({
      config: options.config,
      pathIndex: options.pathIndex,
      referencePath: reference.resolvedPath,
      sourceConfigPath: options.sourceConfigPath,
    });
    return referencePath === null ? [] : [referencePath];
  });
}

interface TargetCollectionState {
  entryConfigPaths: Set<string>;
  expandedSolutions: Set<string>;
  planningVirtualFiles: Map<string, string>;
  queued: MigrationEntry[];
  queuedConfigPaths: Set<string>;
  recursiveReferencePaths: Set<string>;
  unsupportedNamedSolutionPaths: Set<string>;
  targetsByPath: Map<string, MigrationTarget>;
}

function createTargetCollectionState(
  entries: MigrationEntry[],
): TargetCollectionState {
  return {
    entryConfigPaths: new Set(entries.map((entry) => entry.configPath)),
    expandedSolutions: new Set(),
    planningVirtualFiles: new Map(),
    queued: [...entries],
    queuedConfigPaths: new Set(entries.map((entry) => entry.configPath)),
    recursiveReferencePaths: new Set(),
    unsupportedNamedSolutionPaths: new Set(),
    targetsByPath: new Map(),
  };
}

async function ensureTarget(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  state: TargetCollectionState;
}): Promise<MigrationTarget> {
  const cached = options.state.targetsByPath.get(options.configPath);
  if (cached !== undefined) {
    return cached;
  }
  const target = await readMigrationTarget({
    config: options.config,
    configPath: options.configPath,
    planningVirtualFiles: options.state.planningVirtualFiles,
  });
  options.state.targetsByPath.set(options.configPath, target);
  return target;
}

function queueReference(
  referencePath: string,
  state: TargetCollectionState,
): void {
  if (!state.entryConfigPaths.has(referencePath)) {
    state.recursiveReferencePaths.add(referencePath);
  }
  if (!state.queuedConfigPaths.has(referencePath)) {
    state.queuedConfigPaths.add(referencePath);
    state.queued.push({ configPath: referencePath });
  }
}

function shouldExpandSolution(options: {
  entry: MigrationEntry;
  state: TargetCollectionState;
  target: MigrationTarget;
}): boolean {
  return (
    options.target.isTypeScriptSolution &&
    !options.state.expandedSolutions.has(options.entry.configPath)
  );
}

async function expandSolutionTarget(options: {
  config: ResolvedLiminaConfig;
  entry: MigrationEntry;
  pathIndex: WorkspaceRegionPathIndex;
  state: TargetCollectionState;
  target: MigrationTarget;
}): Promise<void> {
  if (!shouldExpandSolution(options)) {
    return;
  }
  options.state.expandedSolutions.add(options.entry.configPath);
  const references = collectReferenceTargets({
    config: options.config,
    pathIndex: options.pathIndex,
    planningVirtualFiles: options.state.planningVirtualFiles,
    sourceConfigPath: options.entry.configPath,
  });
  for (const referencePath of references) {
    queueReference(referencePath, options.state);
  }
}

function recordUnsupportedNamedSolution(
  rootDir: string,
  state: TargetCollectionState,
  target: MigrationTarget,
): void {
  if (
    isUnsupportedNamedSolutionConfig({
      configObject: target.configObject,
      configPath: target.configPath,
      fileNames: target.effectiveConfig.fileNames,
      rootDir,
    })
  ) {
    state.unsupportedNamedSolutionPaths.add(target.configPath);
  }
}

async function collectTargetClosure(options: {
  config: ResolvedLiminaConfig;
  pathIndex: WorkspaceRegionPathIndex;
  state: TargetCollectionState;
}): Promise<void> {
  for (const entry of options.state.queued) {
    const target = await ensureTarget({
      config: options.config,
      configPath: entry.configPath,
      state: options.state,
    });
    recordUnsupportedNamedSolution(
      options.config.rootDir,
      options.state,
      target,
    );
    await expandSolutionTarget({
      config: options.config,
      entry,
      pathIndex: options.pathIndex,
      state: options.state,
      target,
    });
  }
}

export async function collectMigrationTargets(
  config: ResolvedLiminaConfig,
  context: ValidatedWorkspaceContext,
): Promise<MigrationTargetCollection> {
  const entryCollection = await collectMigrationEntries(
    config,
    context.sourceConfigPaths,
  );
  if (entryCollection.entries.length === 0) {
    throw createNoMigrationEntryError(config, entryCollection);
  }
  const pathIndex = new WorkspaceRegionPathIndex(context);
  const state = createTargetCollectionState(entryCollection.entries);
  await collectTargetClosure({ config, pathIndex, state });
  if (state.unsupportedNamedSolutionPaths.size > 0) {
    throw createUnsupportedNamedSolutionError(
      config,
      state.unsupportedNamedSolutionPaths,
    );
  }

  return {
    checkerEntryCount: state.entryConfigPaths.size,
    recursiveReferenceCount: state.recursiveReferencePaths.size,
    targets: [...state.targetsByPath.values()].sort((left, right) =>
      compareCodeUnits(left.configPath, right.configPath),
    ),
  };
}
