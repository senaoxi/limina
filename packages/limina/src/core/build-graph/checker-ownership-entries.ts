import {
  getActiveCheckers,
  getAutoCheckerConfig,
  type ResolvedLiminaInputs,
} from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import {
  createCheckerEntrySelectionOptions,
  resolveCheckerEntrySelection,
} from '../checkers/entry-selection';
import type { ResolvedCheckerEntrySelection } from './types';

async function collectNamedSelections(options: {
  config: ResolvedLiminaInputs;
  sourceConfigPaths: readonly string[];
}): Promise<ResolvedCheckerEntrySelection[]> {
  return Promise.all(
    getActiveCheckers(options.config).map(async (checker) => ({
      checker,
      selection: await resolveCheckerEntrySelection(
        {
          config: options.config,
          sourceConfigPaths: options.sourceConfigPaths,
        },
        createCheckerEntrySelectionOptions(checker),
      ),
    })),
  );
}

async function collectAutoEntryPaths(options: {
  config: ResolvedLiminaInputs;
  sourceConfigPaths: readonly string[];
}): Promise<string[]> {
  const auto = getAutoCheckerConfig(options.config.scope?.checkers);
  const selection = await resolveCheckerEntrySelection(
    {
      config: options.config,
      sourceConfigPaths: options.sourceConfigPaths,
    },
    {
      checkerName: '__auto__',
      exclude: auto.exclude ?? [],
      include: ['**/tsconfig.json'],
    },
  );
  return selection.effectiveEntryPaths;
}

function collectActiveEntryPaths(options: {
  autoEntryPaths: readonly string[];
  namedSelections: readonly ResolvedCheckerEntrySelection[];
}): string[] {
  return [
    ...new Set([
      ...options.autoEntryPaths,
      ...options.namedSelections.flatMap(
        (selection) => selection.selection.effectiveEntryPaths,
      ),
    ]),
  ].sort(compareCodeUnits);
}

export async function resolveOwnershipEntries(options: {
  config: ResolvedLiminaInputs;
  sourceConfigPaths: readonly string[];
}): Promise<{
  namedSelections: ResolvedCheckerEntrySelection[];
  activeEntryPaths: string[];
}> {
  const namedSelections = await collectNamedSelections(options);
  const autoEntryPaths = await collectAutoEntryPaths(options);
  return {
    namedSelections,
    activeEntryPaths: collectActiveEntryPaths({
      autoEntryPaths,
      namedSelections,
    }),
  };
}
