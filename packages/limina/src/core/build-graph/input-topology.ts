import {
  getActiveCheckers,
  getAutoCheckerConfig,
  type ResolvedLiminaConfig,
} from '#config/runner';
import { collectRawWorkspacePackages } from '#core/workspace/actions';
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
import { readImplicitRefs } from './generated/config-readers';
import { collectCheckerSourceConfigModules } from './source-config-collection';
import { createEmptySourceConfigCollection } from './source-config-root-collection';

export interface InputTopologyDiagnostic {
  configPath: string;
  phase: 'workspace' | 'entry' | 'config';
  message: string;
  code?: string;
}

/** Current-input facts only. No checker ownership or executable graph authority. */
export interface InputTopologyResult {
  complete: boolean;
  diagnostics: InputTopologyDiagnostic[];
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
    entries: [],
    sources: [],
    solutions: [],
    reachableSources: {},
  };
}

async function readWorkspace(
  config: ResolvedLiminaConfig,
  result: InputTopologyResult,
): Promise<boolean> {
  try {
    result.workspace = await collectValidatedWorkspaceContext({
      config,
      rawPackages: await collectRawWorkspacePackages(config),
    });
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

function readEntry(
  config: ResolvedLiminaConfig,
  result: InputTopologyResult,
  entry: string,
) {
  const collection = createEmptySourceConfigCollection([entry]);
  const problems: string[] = [];
  collectCheckerSourceConfigModules({
    activatedRegions: new WorkspaceRegionPathIndex(result.workspace!),
    checkerName: 'tsc',
    checkerPreset: 'tsc',
    collection,
    config,
    problems,
    seenConfigs: new Set(),
    sourceConfigPath: entry,
    onInputError: (configPath, error) =>
      result.diagnostics.push({
        configPath,
        phase: 'config',
        message: error.message,
      }),
  });
  result.diagnostics.push(
    ...problems.map((message) => ({
      configPath: entry,
      phase: 'config' as const,
      message,
    })),
  );
  result.reachableSources[entry] = [...collection.projectConfigPaths].sort();
  return collection;
}

function readExplicitDeclarations(
  config: ResolvedLiminaConfig,
  result: InputTopologyResult,
  source: string,
): void {
  const refs = readImplicitRefs(config, source);
  const outside = refs.implicitRefs.filter(
    (ref) => !result.sources.includes(ref.targetConfigPath),
  );
  const messages = [
    ...refs.problems,
    ...outside.map(
      (ref) =>
        `implicitRefs target is outside the effective source topology: ${ref.path}`,
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

/** Collects input facts using the normal entry and config readers, without granting checker ownership. */
export async function readInputTopology(
  config: ResolvedLiminaConfig,
): Promise<InputTopologyResult> {
  const result = emptyTopology();
  if (!(await readWorkspace(config, result))) return result;
  const selected = await Promise.all(
    checkerSelections(config).map((selection) =>
      readSelection(config, result, selection),
    ),
  );
  result.entries = [...new Set(selected.flat())].sort();
  const collections = result.entries.map((entry) =>
    readEntry(config, result, entry),
  );
  result.sources = [
    ...new Set(
      collections.flatMap((collection) => [...collection.projectConfigPaths]),
    ),
  ].sort();
  result.solutions = [
    ...new Set(
      collections.flatMap((collection) => [...collection.solutionConfigPaths]),
    ),
  ].sort();
  readSolutionReachability(config, result);
  for (const source of [...result.sources, ...result.solutions])
    readExplicitDeclarations(config, result, source);
  result.complete = result.diagnostics.length === 0;
  return result;
}

function readSolutionReachability(
  config: ResolvedLiminaConfig,
  result: InputTopologyResult,
): void {
  for (const solution of result.solutions) readEntry(config, result, solution);
}
