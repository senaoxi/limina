import type { ResolvedLiminaConfig } from '#config/runner';
import { LIMINA_CHECK_ISSUE_CODES } from '../../check-reporting/codes';
import { LiminaStructuredError } from '../../check-reporting/errors';
import {
  createTaskFailureIssue,
  type LiminaCheckIssue,
} from '../../check-reporting/snapshot';
import {
  createAmbiguousCrossCheckerProviderIssue,
  createOutputBuildCacheBoundaryConflictIssue,
  createUnsafeCrossEngineProviderIssue,
} from './graph-prepare-issues';
import {
  findGeneratedGraphProblemLineValue,
  getGeneratedGraphProblemTitle,
} from './problem-parsing';

export function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function formatProblemList(
  problems: readonly string[],
  fallback: string,
): string {
  if (problems.length === 0) {
    return fallback;
  }
  if (problems.length === 1) {
    return getGeneratedGraphProblemTitle(problems[0]!.split('\n'));
  }

  return `${problems.length} generated graph preparation problems.`;
}

type SpecializedIssueFactory = (options: {
  config: ResolvedLiminaConfig;
  lines: readonly string[];
}) => LiminaCheckIssue;

const SPECIALIZED_ISSUE_FACTORIES: ReadonlyMap<
  string,
  SpecializedIssueFactory
> = new Map([
  [
    'Unsafe cross-engine declaration provider',
    createUnsafeCrossEngineProviderIssue,
  ],
  [
    'Ambiguous cross-checker declaration provider',
    createAmbiguousCrossCheckerProviderIssue,
  ],
  [
    'Output build cache boundary conflict',
    createOutputBuildCacheBoundaryConflictIssue,
  ],
]);

function createDefaultGeneratedGraphProblemIssue(options: {
  config: ResolvedLiminaConfig;
  fallback: string;
  lines: readonly string[];
  title: string;
}): LiminaCheckIssue {
  const filePath = findGeneratedGraphProblemLineValue(options.lines, [
    'config',
    'file',
    'project',
    'source config',
  ]);
  const reason = findGeneratedGraphProblemLineValue(options.lines, ['reason']);

  return createTaskFailureIssue({
    code: LIMINA_CHECK_ISSUE_CODES.graphPrepareFailed,
    detailLines: options.lines,
    filePath: filePath ?? options.config.configPath,
    fix: 'Inspect the generated graph diagnostic, then update checker.include, tsconfig references, or generated graph configuration before rerunning `limina graph prepare`.',
    reason: reason ?? options.fallback,
    rootDir: options.config.rootDir,
    task: 'graph:prepare',
    title: options.title,
    verifyCommands: ['limina graph prepare'],
  });
}

function createGeneratedGraphProblemIssue(options: {
  config: ResolvedLiminaConfig;
  fallback: string;
  problem: string;
}): LiminaCheckIssue {
  const lines = options.problem.split('\n');
  const title = getGeneratedGraphProblemTitle(lines);
  const factory = SPECIALIZED_ISSUE_FACTORIES.get(title);
  if (factory) {
    return factory({ config: options.config, lines });
  }

  return createDefaultGeneratedGraphProblemIssue({
    config: options.config,
    fallback: options.fallback,
    lines,
    title,
  });
}

export function createGeneratedGraphStructuredError(options: {
  config: ResolvedLiminaConfig;
  fallback: string;
  problems: readonly string[];
}): LiminaStructuredError {
  return new LiminaStructuredError(
    formatProblemList(options.problems, options.fallback),
    options.problems.map((problem) =>
      createGeneratedGraphProblemIssue({
        config: options.config,
        fallback: options.fallback,
        problem,
      }),
    ),
  );
}
