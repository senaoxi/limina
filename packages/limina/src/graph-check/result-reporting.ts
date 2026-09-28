import {
  type CheckIssueReportOptions,
  formatCheckIssueHumanReport,
} from '../check-reporting/human';
import type { LiminaCheckIssue } from '../check-reporting/snapshot';
import { GraphLogger } from '../logger';
import { shouldUseColor } from '../utils/reporting';
import { createGraphCheckIssuesFromFindings } from './findings';
import type { GraphCheckState } from './run-state';

function pushIssues(
  target: LiminaCheckIssue[] | undefined,
  issues: LiminaCheckIssue[],
): void {
  target?.push(...issues);
}

function isReportDeferred(
  report: CheckIssueReportOptions | undefined,
): boolean {
  return report?.defer === true;
}

function getReportCommand(report: CheckIssueReportOptions | undefined): string {
  return report?.command ?? 'limina graph check';
}

function getReportVerbose(
  report: CheckIssueReportOptions | undefined,
): boolean | undefined {
  return report?.verbose;
}

function logFailure(
  issues: LiminaCheckIssue[],
  report: CheckIssueReportOptions | undefined,
): void {
  if (isReportDeferred(report)) {
    return;
  }

  GraphLogger.error(
    formatCheckIssueHumanReport({
      color: shouldUseColor(),
      command: getReportCommand(report),
      issues,
      title: 'Graph check summary',
      verbose: getReportVerbose(report),
    }),
  );
}

function reportGraphFailure(state: GraphCheckState): false {
  const issues = createGraphCheckIssuesFromFindings({
    config: state.config,
    findings: state.findings,
  });

  state.options.onStats?.({
    items: state.checkItems.getItems(),
    passed: 0,
    total: state.checks.value,
  });
  pushIssues(state.options.issues, issues);
  logFailure(issues, state.options.report);
  return false;
}

function reportGraphSuccess(state: GraphCheckState): true {
  if (state.options.logSuccess !== false) {
    GraphLogger.success(
      `Checked ${state.projects.length} graph projects; references are valid.`,
    );
  }

  state.options.onStats?.({
    items: state.checkItems.getItems(),
    passed: state.checks.value,
    total: state.checks.value,
  });
  return true;
}

export function finishGraphCheck(state: GraphCheckState): boolean {
  return state.findings.length > 0
    ? reportGraphFailure(state)
    : reportGraphSuccess(state);
}
