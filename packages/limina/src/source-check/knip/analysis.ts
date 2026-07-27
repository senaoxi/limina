import { isNamedWorkspacePackage } from '#core/workspace/actions';
import type { JSONReport } from 'knip';
import { runKnipCli } from './cli';
import { createKnipConfigForSourceAnalysis } from './config';
import {
  collectUnusedSourceFileIssues,
  collectUnusedWorkspaceDependencyIssues,
} from './report-issues';
import { parseKnipJsonReport } from './report-parser';
import {
  withKnipAnalysisRoot,
  withTemporaryKnipConfig,
  withTemporaryVirtualEntries,
} from './temp';
import type {
  CollectKnipSourceIssuesOptions,
  KnipCliInvocation,
  KnipCliRunner,
  KnipOwnerProject,
  KnipSourceAnalysisGroup,
  KnipSourceIssues,
  KnipSourceIssueType,
  KnipUnusedSourceFileIssue,
} from './types';

function hasWorkspaceSelection(group: KnipSourceAnalysisGroup): boolean {
  if (group.workspaceNames === undefined) {
    return true;
  }

  return group.workspaceNames.length > 0;
}

function normalizeAnalysisGroups(
  groups: readonly KnipSourceAnalysisGroup[] | undefined,
): KnipSourceAnalysisGroup[] {
  if (groups === undefined) {
    return [{}];
  }

  const nonEmptyGroups = groups.filter(hasWorkspaceSelection);
  return nonEmptyGroups.length === 0 ? [{}] : nonEmptyGroups;
}

function mergeKnipReports(reports: readonly JSONReport[]): JSONReport {
  const firstReport = reports[0];
  return {
    ...firstReport,
    issues: reports.flatMap((report) => report.issues),
  };
}

function getIssueTypes(includeFiles: boolean): KnipSourceIssueType[] {
  return includeFiles ? ['dependencies', 'files'] : ['dependencies'];
}

function createInvocation(options: {
  analysisGroup: KnipSourceAnalysisGroup;
  analysisRootDir: string;
  configPath: string;
  include: KnipSourceIssueType[];
}): KnipCliInvocation {
  const invocation: KnipCliInvocation = {
    configPath: options.configPath,
    include: options.include,
    rootDir: options.analysisRootDir,
  };
  if (options.analysisGroup.tsConfigFile !== undefined) {
    invocation.tsConfigFile = options.analysisGroup.tsConfigFile;
  }
  if (options.analysisGroup.workspaceNames !== undefined) {
    invocation.workspaceNames = options.analysisGroup.workspaceNames;
  }
  return invocation;
}

async function runAnalysisGroup(options: {
  analysisGroup: KnipSourceAnalysisGroup;
  analysisRootDir: string;
  configPath: string;
  include: KnipSourceIssueType[];
  runner: KnipCliRunner;
}): Promise<JSONReport> {
  const output = await options.runner(createInvocation(options));
  return parseKnipJsonReport(output);
}

async function runAnalysisGroups(options: {
  analysisGroups: KnipSourceAnalysisGroup[];
  analysisRootDir: string;
  configPath: string;
  include: KnipSourceIssueType[];
  runner: KnipCliRunner;
}): Promise<JSONReport> {
  const reports = await Promise.all(
    options.analysisGroups.map((analysisGroup) =>
      runAnalysisGroup({ ...options, analysisGroup }),
    ),
  );
  return mergeKnipReports(reports);
}

async function runWithTemporaryConfig(options: {
  analysisGroups: KnipSourceAnalysisGroup[];
  analysisRootDir: string;
  collectOptions: CollectKnipSourceIssuesOptions;
  include: KnipSourceIssueType[];
  ownerProjects: KnipOwnerProject[];
  runner: KnipCliRunner;
}): Promise<JSONReport> {
  const config = createKnipConfigForSourceAnalysis({
    ignoredKeys: options.collectOptions.ignoredKeys,
    ownerProjects: options.ownerProjects,
    rootDir: options.collectOptions.config.rootDir,
    workspacePackages: options.collectOptions.workspacePackages,
  });
  return withTemporaryKnipConfig(config, (configPath) =>
    runAnalysisGroups({
      analysisGroups: options.analysisGroups,
      analysisRootDir: options.analysisRootDir,
      configPath,
      include: options.include,
      runner: options.runner,
    }),
  );
}

async function collectKnipReport(
  options: CollectKnipSourceIssuesOptions,
): Promise<JSONReport> {
  const analysisGroups = normalizeAnalysisGroups(options.analysisGroups);
  const include = getIssueTypes(options.includeFiles);
  const runner =
    options.knipRunner === undefined ? runKnipCli : options.knipRunner;

  return withTemporaryVirtualEntries(options.ownerProjects, (ownerProjects) =>
    withKnipAnalysisRoot(options.config.rootDir, (analysisRootDir) =>
      runWithTemporaryConfig({
        analysisGroups,
        analysisRootDir,
        collectOptions: options,
        include,
        ownerProjects,
        runner,
      }),
    ),
  );
}

function collectWorkspacePackageNames(
  options: CollectKnipSourceIssuesOptions,
): Set<string> {
  return new Set(
    options.workspacePackages
      .filter(isNamedWorkspacePackage)
      .map((workspacePackage) => workspacePackage.name),
  );
}

function collectOptionalSourceFileIssues(options: {
  collectOptions: CollectKnipSourceIssuesOptions;
  report: JSONReport;
}): KnipUnusedSourceFileIssue[] {
  if (!options.collectOptions.includeFiles) {
    return [];
  }

  return collectUnusedSourceFileIssues({
    report: options.report,
    rootDir: options.collectOptions.config.rootDir,
  });
}

export async function collectKnipSourceIssues(
  options: CollectKnipSourceIssuesOptions,
): Promise<KnipSourceIssues> {
  const report = await collectKnipReport(options);
  return {
    unusedSourceFiles: collectOptionalSourceFileIssues({
      collectOptions: options,
      report,
    }),
    unusedWorkspaceDependencies: collectUnusedWorkspaceDependencyIssues({
      report,
      rootDir: options.config.rootDir,
      workspacePackageNames: collectWorkspacePackageNames(options),
    }),
  };
}
