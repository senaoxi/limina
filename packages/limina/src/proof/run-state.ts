import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import { collectGeneratedSourceConfigPaths } from '#core/build-graph/runner';
import {
  type CheckerGraphProjectRoute,
  isDtsConfigPath,
} from '#core/tsconfig/actions';
import { uniqueCodeUnitSortedStrings as uniqueSortedStrings } from '#utils/collections';
import {
  appendCheckIssues,
  type LiminaCheckIssue,
} from '../check-reporting/snapshot';
import {
  createCheckCounter,
  createCheckItemAccumulator,
} from '../check-reporting/stats';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import { ProofLogger } from '../logger';
import { resolvePreflight } from '../preflight';
import {
  collectProofReportIssues,
  formatProofFindingReport,
} from './finding-utils';
import type { ProofFinding } from './findings';
import {
  type CheckerCoverageTarget,
  PROOF_CHECK_ITEM_NAMES,
  type RunProofCheckImplOptions,
} from './runner-types';

export interface ProofRunState {
  checkerTargets: CheckerCoverageTarget[];
  checks: ReturnType<typeof createCheckCounter>;
  checkItems: ReturnType<typeof createCheckItemAccumulator>;
  config: ResolvedLiminaConfig;
  dtsConfigPaths: string[];
  entryProjectPaths: string[];
  entryRoutes: CheckerGraphProjectRoute[];
  findings: ProofFinding[];
  generatedGraph: GeneratedTsconfigGraphResult;
  graphRoutes: CheckerGraphProjectRoute[];
  options: RunProofCheckImplOptions;
  ordinaryConfigPaths: string[];
  preflight: ReturnType<typeof resolvePreflight>;
  workspaceLookup: WorkspaceLookupIndex;
}

export type ProofPhase = (state: ProofRunState) => Promise<boolean>;

function pushOptional<T>(target: T[] | undefined, values: readonly T[]): void {
  target?.push(...values);
}

async function collectFindings(
  state: ProofRunState,
): Promise<LiminaCheckIssue[]> {
  pushOptional(state.options.findingSink, state.findings);
  const issues = collectProofReportIssues({
    config: state.config,
    findings: state.findings,
  });

  pushOptional(state.options.issues, issues);
  if (state.options.deferSnapshot !== true) {
    await appendCheckIssues({
      artifactNamespace: state.preflight.artifactNamespace,
      issues,
      rootDir: state.config.rootDir,
    });
  }

  return issues;
}

function logFailure(state: ProofRunState, issues: LiminaCheckIssue[]): void {
  if (state.options.report?.defer === true) {
    return;
  }

  ProofLogger.error(
    formatProofFindingReport({
      config: state.config,
      findings: state.findings,
      issues,
      report: state.options.report,
    }),
  );
}

export async function finishProofPhase(state: ProofRunState): Promise<boolean> {
  if (state.findings.length === 0) {
    return true;
  }

  state.options.onStats?.({
    items: state.checkItems.getItems(),
    passed: 0,
    total: state.checks.value,
  });
  logFailure(state, await collectFindings(state));
  return false;
}

export async function createProofRunState(
  config: ResolvedLiminaConfig,
  options: RunProofCheckImplOptions,
): Promise<ProofRunState> {
  const findings: ProofFinding[] = [];
  const checks = createCheckCounter();
  const checkItems = createCheckItemAccumulator(
    () => findings.length,
    () => checks.value,
    { plannedItems: PROOF_CHECK_ITEM_NAMES, progress: options.progress },
  );
  const preflight = resolvePreflight(config, options);
  const generatedGraph = await preflight.ensureGeneratedGraph();
  const graphRoutes = (await preflight.ensureGraphProjectRoutes()).routes;
  const entryRoutes = (await preflight.ensureCheckerEntryProjectRoutes())
    .routes;
  const entryProjectPaths = uniqueSortedStrings(
    entryRoutes.flatMap((route) => route.projectPaths),
  );

  return {
    checkerTargets: [],
    checks,
    checkItems,
    config,
    dtsConfigPaths: entryProjectPaths.filter(isDtsConfigPath),
    entryProjectPaths,
    entryRoutes,
    findings,
    generatedGraph,
    graphRoutes,
    options,
    ordinaryConfigPaths: collectGeneratedSourceConfigPaths(generatedGraph),
    preflight,
    workspaceLookup: await preflight.ensureWorkspaceLookupIndex(),
  };
}
