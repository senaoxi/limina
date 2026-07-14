import type { ResolvedLiminaConfig } from '#config/runner';
import type { AnalysisProviderSet } from '#core';
import { isLocalPackageDependencySpecifier } from '#core/workspace/actions';
import { toRelativePath } from '#utils/path';
import { createElapsedTimer } from 'logaria/helper';
import path from 'pathe';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import {
  type CheckIssueReportOptions,
  formatCheckIssueHumanReport,
} from '../check-reporting/human';
import type { LiminaCheckRunTaskStats } from '../check-reporting/run-recorder';
import {
  appendCheckIssues,
  completeCheckIssueSnapshot,
  createTaskFailureIssue,
  type LiminaCheckIssue,
  type LiminaCheckRunCheckItemSummary,
} from '../check-reporting/snapshot';
import { createCheckItemStats } from '../check-reporting/stats';
import { resolveReleaseEntryConcurrency } from '../execution/config';
import { runPool } from '../execution/pool';
import type {
  TaskProgressItem,
  TaskProgressReporter,
} from '../execution/progress';
import type { LiminaFlowReporter } from '../flow';
import { clearCliScreen, formatErrorMessage, ReleaseLogger } from '../logger';
import {
  assertPackageReleaseConsistency,
  PackageReleaseConsistencyError,
} from '../package-check/release-consistency';
import {
  type DistPackageJson,
  type PackageEntrySelectionPlan,
  type PackedPackageTarball,
  packOutputTarball,
  readDistPackageJson,
} from '../package-check/runner';
import { type LiminaPreflightManager, resolvePreflight } from '../preflight';

export interface RunReleaseCheckOptions {
  clearScreen?: boolean;
  config: ResolvedLiminaConfig;
  providers?: AnalysisProviderSet;
  cwd?: string;
  deferSnapshot?: boolean;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  issues?: LiminaCheckIssue[];
  onStats?: (stats: LiminaCheckRunTaskStats) => void;
  packageNames?: readonly string[];
  preflight?: LiminaPreflightManager;
  progress?: TaskProgressReporter;
  report?: CheckIssueReportOptions;
}

interface ReleaseCheckEntryRunResult {
  durationMs: number;
  issues: LiminaCheckIssue[];
  label: string;
  passed: boolean;
}

type ReleasePlanEntry = PackageEntrySelectionPlan['entries'][number];

function logReleaseCheckPlan(options: {
  config: ResolvedLiminaConfig;
  cwd: string;
  plan: PackageEntrySelectionPlan;
}): void {
  ReleaseLogger.info(
    [
      'Release check plan:',
      `  config: ${toRelativePath(
        options.config.rootDir,
        options.config.configPath,
      )}`,
      `  cwd: ${toRelativePath(options.config.rootDir, options.cwd)}`,
      `  selection: ${options.plan.selectionReason}`,
      '  entries:',
      ...options.plan.entries.map((entry) =>
        [
          `    - ${entry.label}`,
          `      outDir: ${toRelativePath(options.config.rootDir, entry.outDir)}`,
        ].join('\n'),
      ),
    ].join('\n'),
  );
}

function createReleaseProgressItems(
  entries: readonly ReleasePlanEntry[],
  progress: TaskProgressReporter | undefined,
): Map<string, TaskProgressItem | undefined> {
  return new Map(
    entries.map((entry) => [entry.label, progress?.planItem(entry.label)]),
  );
}

function finishReleaseProgressItem(
  progressItem: TaskProgressItem | undefined,
  result: ReleaseCheckEntryRunResult,
): void {
  if (result.passed) {
    progressItem?.pass(undefined, {
      elapsedTimeMs: result.durationMs,
    });
  } else {
    progressItem?.fail(undefined, {
      elapsedTimeMs: result.durationMs,
    });
  }
}

function collectOutputManifestProblems(options: {
  label: string;
  manifest: DistPackageJson;
  outDir: string;
  rootDir: string;
}): string[] {
  const sections = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ] as const;
  const problems: string[] = [];

  for (const sectionName of sections) {
    const section = options.manifest[sectionName];

    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      continue;
    }

    for (const [dependencyName, specifier] of Object.entries(section)) {
      if (
        typeof specifier !== 'string' ||
        !isLocalPackageDependencySpecifier(specifier)
      ) {
        continue;
      }

      problems.push(
        [
          `${options.label}: ${options.manifest.name} -> ${dependencyName} [${sectionName}] (${specifier}): output package manifest must not expose workspace:, link:, file:, or catalog: dependency specifiers`,
          `  output: ${toRelativePath(options.rootDir, options.outDir)}`,
        ].join('\n'),
      );
    }
  }

  return problems;
}

function getReleaseConsistencySectionCode(
  section: string,
  body: string,
): string {
  if (section.includes('tarball')) {
    return LIMINA_CHECK_ISSUE_CODES.releaseTarballHygiene;
  }

  if (
    section.includes('Packed package manifest') ||
    section.includes('Output package manifest') ||
    section.includes('Source manifest')
  ) {
    return LIMINA_CHECK_ISSUE_CODES.releasePackedManifest;
  }

  if (/content hash|local-only|remote-only|changed/iu.test(body)) {
    return LIMINA_CHECK_ISSUE_CODES.releaseContentHash;
  }

  if (section.includes('registry') || section.includes('published')) {
    return LIMINA_CHECK_ISSUE_CODES.releaseRegistry;
  }

  return LIMINA_CHECK_ISSUE_CODES.releaseConsistency;
}

function createReleaseConsistencyIssues(options: {
  error: PackageReleaseConsistencyError;
  label: string;
  outputPackageJsonPath: string;
  rootDir: string;
}): LiminaCheckIssue[] {
  const lines = formatErrorMessage(options.error).split('\n');
  const issues: LiminaCheckIssue[] = [];
  let sectionTitle = 'Release consistency issue';
  let sectionLines: string[] = [];

  const flush = (): void => {
    if (sectionLines.length === 0) {
      return;
    }

    const body = sectionLines.join('\n');
    const code = getReleaseConsistencySectionCode(sectionTitle, body);

    issues.push(
      createTaskFailureIssue({
        code,
        detailLines: [sectionTitle, ...sectionLines],
        domain: 'release',
        evidence: [
          {
            label: sectionTitle.replace(/:$/u, ''),
            lines: sectionLines,
          },
        ],
        filePath: options.outputPackageJsonPath,
        fix: 'Inspect the release check report, rebuild the package output, or adjust release metadata before publishing.',
        fixSteps: [
          'Inspect the release check section shown in this issue.',
          'Rebuild the package output or adjust release metadata for the failing section.',
          'Rerun the release check before publishing.',
        ],
        packageManifestPath: options.outputPackageJsonPath,
        packageName: options.label,
        reason: sectionTitle.replace(/:$/u, ''),
        rootDir: options.rootDir,
        summary: sectionLines[0]?.replace(/^\s*-\s*/u, '') ?? sectionTitle,
        task: 'release:check',
        title:
          code === LIMINA_CHECK_ISSUE_CODES.releaseConsistency
            ? 'Release consistency issue'
            : sectionTitle.replace(/:$/u, ''),
        tool: 'release',
        verifyCommands: ['limina release check'],
      }),
    );
    sectionLines = [];
  };

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    if (/^[A-Z][^:]+:$/u.test(line.trim())) {
      flush();
      sectionTitle = line.trim();
      continue;
    }

    if (/^\s+-\s+/u.test(line) || sectionLines.length > 0) {
      sectionLines.push(line);
    }
  }

  flush();

  return issues.length > 0
    ? issues
    : [
        createTaskFailureIssue({
          code: LIMINA_CHECK_ISSUE_CODES.releaseConsistency,
          detailLines: lines,
          filePath: options.outputPackageJsonPath,
          fix: 'Inspect the release check report, rebuild the package output, or adjust release metadata before publishing.',
          packageManifestPath: options.outputPackageJsonPath,
          packageName: options.label,
          reason:
            'Release check found package output or tarball consistency failures.',
          rootDir: options.rootDir,
          task: 'release:check',
          title: 'Release consistency issue',
          tool: 'release',
        }),
      ];
}

async function packReleaseTarball(options: {
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  label: string;
  outDir: string;
}): Promise<PackedPackageTarball> {
  const packTask = options.flow?.start(`release tarball: ${options.label}`, {
    depth: options.flowDepth ?? 0,
  });
  ReleaseLogger.info(`release tarball packing started: ${options.label}`);
  const packElapsed = createElapsedTimer();

  try {
    const packedDist = await packOutputTarball(options.outDir);

    if (!options.flow?.interactive) {
      ReleaseLogger.success(
        `release tarball packed: ${options.label}`,
        packElapsed(),
      );
    }

    packTask?.pass();
    return packedDist;
  } catch (error) {
    ReleaseLogger.error(
      `release tarball failed: ${options.label}: ${formatErrorMessage(error)}`,
      packElapsed(),
    );
    packTask?.fail(`release tarball failed: ${options.label}`, { error });
    throw error;
  }
}

async function runReleaseCheckEntry(options: {
  config: ResolvedLiminaConfig;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  issueSink?: LiminaCheckIssue[];
  label: string;
  outDir: string;
  progressItem?: TaskProgressItem;
}): Promise<boolean> {
  const task = options.progressItem
    ? undefined
    : options.flow?.start(`release entry: ${options.label}`, {
        depth: options.flowDepth ?? 0,
      });
  const outputPackageJsonPath = path.join(options.outDir, 'package.json');
  let packedDist: PackedPackageTarball | undefined;

  try {
    const outputManifest = await readDistPackageJson({
      config: options.config,
      label: options.label,
      packageJsonPath: outputPackageJsonPath,
    });
    const outputProblems = collectOutputManifestProblems({
      label: options.label,
      manifest: outputManifest,
      outDir: options.outDir,
      rootDir: options.config.rootDir,
    });

    if (outputProblems.length > 0) {
      throw new PackageReleaseConsistencyError(
        [
          `package release check failed for ${options.label}:`,
          `  output: ${toRelativePath(options.config.rootDir, options.outDir)}`,
          '',
          'Output package manifest is not publish-ready:',
          ...outputProblems.map((problem) => `  - ${problem}`),
        ].join('\n'),
      );
    }

    if (outputManifest.private === true) {
      throw new PackageReleaseConsistencyError(
        [
          `package release check failed for ${options.label}:`,
          `  output: ${toRelativePath(options.config.rootDir, options.outDir)}`,
          '',
          'Release tarball is not publishable:',
          `  - ${outputManifest.name}: selected release package has "private": true; npm publish would reject it`,
        ].join('\n'),
      );
    }

    packedDist = await packReleaseTarball({
      flow: options.flow,
      flowDepth: (options.flowDepth ?? 0) + 1,
      label: options.label,
      outDir: options.outDir,
    });

    await assertPackageReleaseConsistency({
      config: options.config,
      label: options.label,
      outDir: options.outDir,
      outputManifest,
      packedTarball: packedDist.tarball,
    });

    if (!options.flow?.interactive) {
      ReleaseLogger.success(`release checks passed: ${options.label}`);
    }

    task?.pass();
    return true;
  } catch (error) {
    if (error instanceof PackageReleaseConsistencyError) {
      options.issueSink?.push(
        ...createReleaseConsistencyIssues({
          error,
          label: options.label,
          outputPackageJsonPath,
          rootDir: options.config.rootDir,
        }),
      );
      ReleaseLogger.error(formatErrorMessage(error));
      task?.fail(`release checks failed: ${options.label}`);
      return false;
    }

    ReleaseLogger.error(
      `release checks failed: ${options.label}: ${formatErrorMessage(error)}`,
    );
    task?.fail(`release checks failed: ${options.label}`, { error });
    throw error;
  } finally {
    if (packedDist) {
      await packedDist.cleanup();
    }
  }
}

async function runReleaseCheckEntries(
  options: RunReleaseCheckOptions,
  entries: readonly ReleasePlanEntry[],
): Promise<ReleaseCheckEntryRunResult[]> {
  if (entries.length === 0) {
    return [];
  }

  const progressItems = createReleaseProgressItems(entries, options.progress);

  return await runPool({
    concurrency: resolveReleaseEntryConcurrency({
      config: options.config,
      itemCount: entries.length,
    }),
    items: entries,
    onError: (entry, error): ReleaseCheckEntryRunResult => ({
      durationMs: 0,
      issues: [
        createTaskFailureIssue({
          code: 'LIMINA_RELEASE_CHECK_FAILED',
          detailLines: [formatErrorMessage(error)],
          filePath: options.config.configPath,
          fix: 'Inspect the release check error above, then rerun `limina release check`.',
          packageName: entry.label,
          reason: `Release check failed: ${formatErrorMessage(error)}.`,
          rootDir: options.config.rootDir,
          task: 'release:check',
          title: 'Release check failed',
          tool: 'release',
        }),
      ],
      label: entry.label,
      passed: false,
    }),
    onResult: (entry, result) => {
      finishReleaseProgressItem(progressItems.get(entry.label), result);
    },
    onStart: (entry) => {
      progressItems.get(entry.label)?.start();
    },
    run: async (entry): Promise<ReleaseCheckEntryRunResult> => {
      const issues: LiminaCheckIssue[] = [];
      const startedAt = performance.now();
      const entryPassed = await runReleaseCheckEntry({
        config: options.config,
        flow: options.flow,
        flowDepth: (options.flowDepth ?? 0) + 1,
        issueSink: issues,
        label: entry.label,
        outDir: entry.outDir,
        progressItem: progressItems.get(entry.label),
      });

      return {
        durationMs: performance.now() - startedAt,
        issues,
        label: entry.label,
        passed: entryPassed,
      };
    },
  });
}

export async function runReleaseCheck(
  options: RunReleaseCheckOptions,
): Promise<boolean> {
  if (options.clearScreen ?? true) {
    clearCliScreen();
  }

  const elapsed = createElapsedTimer();
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const task = options.progress
    ? undefined
    : options.flow?.start('release check', {
        depth: options.flowDepth ?? 0,
      });

  try {
    if (!options.report?.defer) {
      ReleaseLogger.info('release check started');
    }

    const preflight = resolvePreflight(options.config, options);
    const plan = await preflight.ensurePackageEntrySelectionPlan({
      cwd,
      packageNames: options.packageNames,
      requireCwdPackageMatch: true,
    });

    logReleaseCheckPlan({
      config: options.config,
      cwd,
      plan,
    });

    const entryResults = await runReleaseCheckEntries(options, plan.entries);
    const issues = entryResults.flatMap((result) => result.issues);
    const checkItems: LiminaCheckRunCheckItemSummary[] = entryResults.map(
      (result) =>
        createCheckItemStats({
          durationMs: result.durationMs,
          issues: result.passed ? 0 : Math.max(1, result.issues.length),
          name: result.label,
          total: 1,
        }),
    );
    const passed = entryResults.every((result) => result.passed);

    options.issues?.push(...issues);

    options.onStats?.({
      items: checkItems,
      passed: checkItems.reduce(
        (total, item) => total + (item.checksPassed ?? 0),
        0,
      ),
      total: checkItems.length,
    });

    if (passed) {
      if (!options.deferSnapshot) {
        await completeCheckIssueSnapshot({
          rootDir: options.config.rootDir,
        });
      }

      if (!options.report?.defer && !options.flow?.interactive) {
        ReleaseLogger.success('release check finished', elapsed());
      }

      task?.pass();
    } else {
      const reportIssues =
        issues.length > 0
          ? issues
          : [
              createTaskFailureIssue({
                code: 'LIMINA_RELEASE_CHECK_FAILED',
                filePath: options.config.configPath,
                fix: 'Inspect the release check report above, then rebuild or adjust the selected package output before publishing.',
                packageName:
                  options.packageNames?.length === 1
                    ? options.packageNames[0]
                    : undefined,
                reason:
                  'Release check found package output or tarball consistency failures.',
                rootDir: options.config.rootDir,
                task: 'release:check',
                title: 'Release check failed',
                tool: 'release',
              }),
            ];

      if (options.deferSnapshot) {
        options.issues?.push(...reportIssues);
      } else {
        await appendCheckIssues({
          issues: reportIssues,
          rootDir: options.config.rootDir,
        });
      }
      if (!options.report?.defer) {
        ReleaseLogger.error(
          formatCheckIssueHumanReport({
            command: options.report?.command ?? 'limina release check',
            issues: reportIssues,
            title: 'Release check summary',
            verbose: options.report?.verbose,
          }),
          elapsed(),
        );
      }
      task?.fail('release check finished with failures');
    }

    return passed;
  } catch (error) {
    const issue = createTaskFailureIssue({
      code: 'LIMINA_RELEASE_CHECK_FAILED',
      detailLines: [formatErrorMessage(error)],
      filePath: options.config.configPath,
      fix: 'Inspect the release check error above, then rerun `limina release check`.',
      packageName:
        options.packageNames?.length === 1
          ? options.packageNames[0]
          : undefined,
      reason: `Release check failed: ${formatErrorMessage(error)}.`,
      rootDir: options.config.rootDir,
      task: 'release:check',
      title: 'Release check failed',
      tool: 'release',
    });

    if (options.deferSnapshot) {
      options.issues?.push(issue);
    } else {
      await appendCheckIssues({
        issues: [issue],
        rootDir: options.config.rootDir,
      });
    }
    if (!options.report?.defer) {
      ReleaseLogger.error(
        formatCheckIssueHumanReport({
          command: options.report?.command ?? 'limina release check',
          issues: [issue],
          title: 'Release check summary',
          verbose: options.report?.verbose,
        }),
        elapsed(),
      );
    }
    task?.fail('release check failed', { error });
    throw error;
  }
}
