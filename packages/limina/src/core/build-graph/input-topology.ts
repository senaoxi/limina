import {
  getActiveCheckers,
  getAutoCheckerConfig,
  type ResolvedLiminaConfig,
} from '#config/runner';
import { collectRawWorkspacePackages } from '#core/workspace/actions';
import { compareCodeUnits } from '#utils/collections';
import { LiminaStructuredError } from '../../check-reporting/errors';
import {
  CheckerEntryInputError,
  createCheckerEntrySelectionOptions,
  resolveCheckerEntrySelection,
} from '../checkers/entry-selection';
import {
  collectValidatedWorkspaceContext,
  type ValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../workspace/validated-context';
import {
  collectValidatedWorkspaceContextFromSnapshot,
  collectWorkspaceInputSnapshot,
} from '../workspace/validated/create';
import { readImplicitReferences } from './generated/config-readers';
import { collectCheckerSourceConfigModules } from './source-config-collection';
import { createEmptySourceConfigCollection } from './source-config-root-collection';

export interface InputTopologyDiagnostic {
  configPath: string;
  phase: 'workspace' | 'entry' | 'config';
  message: string;
  code?: string;
}

/**
Current-input facts only. No checker ownership or executable graph authority.
*/
export interface InputTopologyResult {
  complete: boolean;
  diagnostics: InputTopologyDiagnostic[];
  configPaths: string[];
  entries: string[];
  sources: string[];
  solutions: string[];
  reachableSources: Record<string, string[]>;
  workspace?: ValidatedWorkspaceContext;
}

function emptyTopology(): InputTopologyResult {
  return {
    complete: false,
    diagnostics: [],
    configPaths: [],
    entries: [],
    sources: [],
    solutions: [],
    reachableSources: {},
  };
}

async function isReadWorkspace(
  config: ResolvedLiminaConfig,
  result: InputTopologyResult,
  readWorkspace: () => Promise<ValidatedWorkspaceContext>,
): Promise<boolean> {
  try {
    result.workspace = await readWorkspace();
    return true;
  } catch (error) {
    if (!(error instanceof LiminaStructuredError)) throw error;
    result.diagnostics.push(
      ...error.issues.map((issue) => ({
        configPath: issue.filePath ?? config.configPath,
        phase: 'workspace' as const,
        message: issue.reason ?? issue.title,
        code: issue.code,
      })),
    );
    return false;
  }
}

function checkerSelections(config: ResolvedLiminaConfig) {
  const auto = getAutoCheckerConfig(config.config?.checkers);
  return [
    {
      checkerName: '__auto__',
      include: ['**/tsconfig.json'],
      exclude: auto.exclude ?? [],
    },
    ...getActiveCheckers(config).map(createCheckerEntrySelectionOptions),
  ];
}

async function readSelection(
  config: ResolvedLiminaConfig,
  result: InputTopologyResult,
  selection: ReturnType<typeof checkerSelections>[number],
): Promise<string[]> {
  try {
    return (
      await resolveCheckerEntrySelection(
        { config, sourceConfigPaths: result.workspace!.sourceConfigPaths },
        selection,
      )
    ).effectiveEntryPaths;
  } catch (error) {
    if (!(error instanceof CheckerEntryInputError)) throw error;
    result.diagnostics.push({
      configPath: config.configPath,
      phase: 'entry',
      message: error.message,
    });
    return [];
  }
}

interface InputReadContext {
  config: ResolvedLiminaConfig;
  result: InputTopologyResult;
  activatedRegions: WorkspaceRegionPathIndex;
}

function readEntry(context: InputReadContext, entry: string) {
  const { config, result, activatedRegions } = context;
  const collection = createEmptySourceConfigCollection([entry]);
  const problems: string[] = [];
  collectCheckerSourceConfigModules({
    activatedRegions,
    checkerName: 'tsc',
    checkerPreset: 'tsc',
    collection,
    config,
    problems,
    seenConfigs: new Set(),
    sourceConfigPath: entry,
    onInputError: (configPath, error) => {
      result.diagnostics.push({
        configPath,
        phase: 'config',
        message: error.message,
      });
    },
  });
  result.diagnostics.push(
    ...problems.map((message) => ({
      configPath: entry,
      phase: 'config' as const,
      message,
    })),
  );
  result.reachableSources[entry] = [...collection.projectConfigPaths].sort(
    compareCodeUnits,
  );
  return collection;
}

function readExplicitDeclarations(
  config: ResolvedLiminaConfig,
  result: InputTopologyResult,
  source: string,
): void {
  const references = readImplicitReferences(config, source);
  const outside = references.implicitRefs.filter(
    (reference) =>
      !result.workspace!.sourceConfigPaths.includes(reference.targetConfigPath),
  );
  const messages = [
    ...references.problems,
    ...outside.map(
      (reference) =>
        `implicitRefs target is outside the activated config topology: ${reference.path}`,
    ),
  ];
  result.diagnostics.push(
    ...messages.map((message) => ({
      configPath: source,
      phase: 'config' as const,
      message,
    })),
  );
}

/**
Collects input facts using the normal entry and config readers, without granting checker ownership.
*/
export async function readInputTopology(
  config: ResolvedLiminaConfig,
): Promise<InputTopologyResult> {
  return readTopology(config, async () =>
    collectValidatedWorkspaceContext({
      config,
      rawPackages: await collectRawWorkspacePackages(config),
    }),
  );
}

/**
One read-only discovery generation for output trials. Only config file overlays
may vary; config/root/regions/package selection remain closed over this reader.
No snapshot is reused by post-write or ordinary core consumption.
*/
export async function createInputTopologyReader(
  config: ResolvedLiminaConfig,
): Promise<
  (
    virtualFiles: ResolvedLiminaConfig['virtualFiles'],
  ) => Promise<InputTopologyResult>
> {
  const rawPackages = await collectRawWorkspacePackages(config);
  const inputSnapshot = await collectWorkspaceInputSnapshot({
    config,
    rawPackages,
  });
  return async (virtualFiles: ResolvedLiminaConfig['virtualFiles']) => {
    const view = { ...config, virtualFiles };
    return readTopology(view, () =>
      collectValidatedWorkspaceContextFromSnapshot({
        config: view,
        rawPackages,
        inputSnapshot,
      }),
    );
  };
}

async function readTopology(
  config: ResolvedLiminaConfig,
  readWorkspace: () => Promise<ValidatedWorkspaceContext>,
): Promise<InputTopologyResult> {
  const result = emptyTopology();
  if (!(await isReadWorkspace(config, result, readWorkspace))) return result;
  result.configPaths = [...result.workspace!.sourceConfigPaths];
  const selected = await Promise.all(
    checkerSelections(config).map((selection) =>
      readSelection(config, result, selection),
    ),
  );
  result.entries = [...new Set(selected.flat())].sort(compareCodeUnits);
  const context: InputReadContext = {
    config,
    result,
    activatedRegions: new WorkspaceRegionPathIndex(result.workspace!),
  };
  const collections = result.entries.map((entry) => readEntry(context, entry));
  result.sources = [
    ...new Set(
      collections.flatMap((collection) => [...collection.projectConfigPaths]),
    ),
  ].sort(compareCodeUnits);
  result.solutions = [
    ...new Set(
      collections.flatMap((collection) => [...collection.solutionConfigPaths]),
    ),
  ].sort(compareCodeUnits);
  readSolutionReachability(context);
  for (const source of [...result.sources, ...result.solutions])
    readExplicitDeclarations(config, result, source);
  result.complete = result.diagnostics.length === 0;
  return result;
}

function readSolutionReachability(context: InputReadContext): void {
  for (const solution of context.result.solutions) readEntry(context, solution);
}
