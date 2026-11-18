import {
  type CheckerName,
  configContextPath,
  getActiveCheckers,
  getAutoCheckerConfig,
  type ResolvedLiminaInputs,
} from '#config/runner';
import { collectRawWorkspacePackages } from '#core/workspace/actions';
import { compareCodeUnits } from '#utils/collections';
import { LiminaStructuredError } from '../../check-reporting/errors';
import {
  CheckerEntryInputError,
  type CheckerEntrySelectionOptions,
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
import { parseScopeProjectInputs } from './auto-checker-project';
import { readImplicitReferences } from './generated/config-readers';
import {
  collectCheckerSourceConfigModules,
  createEmptySourceConfigCollection,
} from './source-config-collection';

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
  config: ResolvedLiminaInputs,
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
        configPath: issue.filePath ?? configContextPath(config),
        phase: 'workspace' as const,
        message: issue.reason ?? issue.title,
        code: issue.code,
      })),
    );
    return false;
  }
}

async function readSelection(
  config: ResolvedLiminaInputs,
  sourceConfigPaths: readonly string[],
  selection: CheckerEntrySelectionOptions,
  diagnostics: InputTopologyDiagnostic[],
): Promise<string[]> {
  try {
    return (
      await resolveCheckerEntrySelection(
        { config, sourceConfigPaths },
        selection,
      )
    ).effectiveEntryPaths;
  } catch (error) {
    if (!(error instanceof CheckerEntryInputError)) throw error;
    diagnostics.push({
      configPath: configContextPath(config),
      phase: 'entry',
      message: error.message,
    });
    return [];
  }
}

export async function readNamedInputEntries(
  config: ResolvedLiminaInputs,
  sourceConfigPaths: readonly string[],
  diagnostics: InputTopologyDiagnostic[] = [],
): Promise<Map<string, CheckerName>> {
  const entries = new Map<string, CheckerName>();
  for (const checker of getActiveCheckers(config)) {
    const paths = await readSelection(
      config,
      sourceConfigPaths,
      createCheckerEntrySelectionOptions(checker),
      diagnostics,
    );
    for (const path of paths)
      if (!entries.has(path)) entries.set(path, checker.name);
  }
  return entries;
}

interface InputReadContext {
  config: ResolvedLiminaInputs;
  result: InputTopologyResult;
  activatedRegions: WorkspaceRegionPathIndex;
  checkerByConfig: Map<string, CheckerName>;
}

function readEntry(context: InputReadContext, entry: string) {
  const { config, result, activatedRegions } = context;
  const collection = createEmptySourceConfigCollection([entry]);
  const problems: string[] = [];
  const reportInput = (configPath: string, error: Error) => {
    result.diagnostics.push({
      configPath,
      phase: 'config',
      message: error.message,
    });
  };
  collectCheckerSourceConfigModules({
    activatedRegions,
    checkerName: 'tsc',
    checkerPreset: 'tsc',
    collection,
    config,
    problems,
    seenConfigs: new Set(),
    sourceConfigPath: entry,
    sourceConfigParser: (configPath, parentPath) => {
      const checkerName =
        context.checkerByConfig.get(configPath) ??
        (parentPath === undefined
          ? undefined
          : context.checkerByConfig.get(parentPath));
      if (checkerName) context.checkerByConfig.set(configPath, checkerName);
      return parseScopeProjectInputs({ config, configPath, checkerName })
        .parsed;
    },
    onInputError: reportInput,
    onInvalidReference: reportInput,
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
  config: ResolvedLiminaInputs,
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
  config: ResolvedLiminaInputs,
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
  config: ResolvedLiminaInputs,
): Promise<
  (
    virtualFiles: ResolvedLiminaInputs['virtualFiles'],
  ) => Promise<InputTopologyResult>
> {
  const rawPackages = await collectRawWorkspacePackages(config);
  const inputSnapshot = await collectWorkspaceInputSnapshot({
    config,
    rawPackages,
  });
  return async (virtualFiles: ResolvedLiminaInputs['virtualFiles']) => {
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
  config: ResolvedLiminaInputs,
  readWorkspace: () => Promise<ValidatedWorkspaceContext>,
): Promise<InputTopologyResult> {
  const result = emptyTopology();
  if (!(await isReadWorkspace(config, result, readWorkspace))) return result;
  result.configPaths = [...result.workspace!.sourceConfigPaths];
  const named = await readNamedInputEntries(
    config,
    result.configPaths,
    result.diagnostics,
  );
  const auto = await readSelection(
    config,
    result.configPaths,
    {
      checkerName: '__auto__',
      include: ['**/tsconfig.json'],
      exclude: getAutoCheckerConfig(config.scope?.checkers).exclude ?? [],
    },
    result.diagnostics,
  );
  const entries = new Set([...named.keys(), ...auto]);
  result.entries = [...entries].sort(compareCodeUnits);
  const context: InputReadContext = {
    config,
    result,
    activatedRegions: new WorkspaceRegionPathIndex(result.workspace!),
    checkerByConfig: named,
  };
  const collections = [...entries].map((entry) => readEntry(context, entry));
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
