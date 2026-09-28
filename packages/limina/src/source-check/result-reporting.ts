import { shouldUseColor } from '#utils/reporting';
import { SourceLogger } from '../logger';
import { formatSourceCheckHumanReport, type SourceCheckIssue } from './report';
import type { SourceCheckState } from './run-state';
import { writeCompletedStandaloneSourceCheckSnapshots } from './snapshot';

type SourceCheckResultInput = Readonly<
  Pick<
    SourceCheckState,
    | 'checkItems'
    | 'checks'
    | 'config'
    | 'findings'
    | 'options'
    | 'preflight'
    | 'sourceIssues'
    | 'sourceProjectEntries'
  >
>;

function collectStructuredIssues(
  state: SourceCheckResultInput,
): SourceCheckIssue[] {
  return [...state.sourceIssues, ...state.findings];
}

function publishStructuredIssues(
  state: SourceCheckResultInput,
  issues: SourceCheckIssue[],
): void {
  state.options.sourceIssues?.push(...issues);
  state.options.onSourceSnapshot?.(issues);
}

function getReportCommand(state: SourceCheckResultInput): string {
  return state.options.report?.command ?? 'limina source check';
}

async function persistIssues(
  state: SourceCheckResultInput,
  issues: SourceCheckIssue[],
): Promise<void> {
  if (state.options.deferSnapshot === true) {
    return;
  }

  await writeCompletedStandaloneSourceCheckSnapshots({
    artifactNamespace: state.preflight.artifactNamespace,
    command: getReportCommand(state),
    issues,
    rootDir: state.config.rootDir,
  });
}

function reportFailureStats(state: SourceCheckResultInput): void {
  state.options.onStats?.({
    items: state.checkItems.getItems(),
    passed: 0,
    total: state.checks.value,
  });
}

function logFailure(
  state: SourceCheckResultInput,
  issues: SourceCheckIssue[],
): void {
  if (state.options.report?.defer === true) {
    return;
  }

  SourceLogger.error(
    formatSourceCheckHumanReport({
      color: shouldUseColor(),
      config: state.config,
      issues,
      report: state.options.report,
    }),
  );
}

function reportSuccess(state: SourceCheckResultInput): true {
  if (state.options.logSuccess !== false) {
    SourceLogger.success(
      `Checked ${state.sourceProjectEntries.length} source project owners; package scopes are valid.`,
    );
  }

  state.options.onStats?.({
    items: state.checkItems.getItems(),
    passed: state.checks.value,
    total: state.checks.value,
  });
  return true;
}

export async function finishSourceCheck(
  state: SourceCheckResultInput,
): Promise<boolean> {
  const issues = collectStructuredIssues(state);

  publishStructuredIssues(state, issues);
  await persistIssues(state, issues);
  if (issues.length === 0) {
    return reportSuccess(state);
  }

  reportFailureStats(state);
  logFailure(state, issues);
  return false;
}
