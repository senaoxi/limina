import { createElapsedTimer } from 'logaria/helper';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  type ChangelogCliOptions,
  ChangelogLogger,
  type PromptVersionSelection,
  REPO_ROOT,
  type ReleasePackageConfig,
  type ReleasePlan,
  type ResolvedReleasePackageConfig,
  compareVersions,
  createGitTag,
  discoverReleasePackages,
  formatReleasePlans,
  getCommitUrl,
  getGitCommand,
  isValidVersion,
  promptForPackageSelections,
  promptForVersionSelection,
  readGitTags,
  resolveDefaultNpmTag,
  resolveNextVersion,
  resolvePackageSelections,
  runCommand,
  selectPreviousGitTag,
  sortReleasePackageConfigs,
  writeJsonFile,
} from './shared';

interface ChangelogSectionBuckets {
  features: string[];
  fixes: string[];
  docs: string[];
  maintenance: string[];
  others: string[];
}

function todayString(): string {
  return new Date().toISOString().split('T')[0];
}

export function createEmptyChangelogTemplate(): string {
  return [
    '<!-- markdownlint-disable MD024 -->',
    '',
    '# Changelog',
    '',
    'All notable changes to this project will be documented in this file.',
    '',
    'The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).',
    '',
    '## [Unreleased]',
    '',
  ].join('\n');
}

export function bucketCommitLines(
  commitLines: string[],
): ChangelogSectionBuckets {
  const buckets: ChangelogSectionBuckets = {
    features: [],
    fixes: [],
    docs: [],
    maintenance: [],
    others: [],
  };

  for (const commitLine of commitLines) {
    if (/^\w+\s+feat(?:ure)?(?:\(|:|!)/.test(commitLine)) {
      buckets.features.push(commitLine);
      continue;
    }
    if (/^\w+\s+(?:fix|bugfix)(?:\(|:|!)/.test(commitLine)) {
      buckets.fixes.push(commitLine);
      continue;
    }
    if (/^\w+\s+docs?(?:\(|:|!)/.test(commitLine)) {
      buckets.docs.push(commitLine);
      continue;
    }
    if (
      /^\w+\s+(?:chore|refactor|style|test|build|ci)(?:\(|:|!)/.test(commitLine)
    ) {
      buckets.maintenance.push(commitLine);
      continue;
    }
    buckets.others.push(commitLine);
  }

  return buckets;
}

function formatCommitEntries(commitLines: string[]): string[] {
  return commitLines.map((commitLine) => {
    const [commitHash, ...rest] = commitLine.split(' ');
    return `- ${rest.join(' ')} ([${commitHash}](${getCommitUrl(commitHash)}))`;
  });
}

export function buildChangelogSection(
  version: string,
  commitLines: string[],
  date = todayString(),
): string {
  const buckets = bucketCommitLines(commitLines);
  const sections: string[] = [`## [${version}] - ${date}`, ''];

  const appendBucket = (title: string, lines: string[]): void => {
    if (lines.length === 0) {
      return;
    }
    sections.push(`### ${title}`, '');
    sections.push(...formatCommitEntries(lines), '');
  };

  appendBucket('Features', buckets.features);
  appendBucket('Bug Fixes', buckets.fixes);
  appendBucket('Documentation', buckets.docs);
  appendBucket('Maintenance', buckets.maintenance);
  appendBucket('Other Changes', buckets.others);

  if (commitLines.length === 0) {
    sections.push('### Other Changes', '');
    sections.push(
      '- No user-facing changes were recorded for this release.',
      '',
    );
  }

  return sections.join('\n').trimEnd() + '\n';
}

export function insertChangelogSection(
  existingContent: string,
  newSection: string,
): string {
  const unreleasedHeading = '## [Unreleased]';
  const unreleasedIndex = existingContent.indexOf(unreleasedHeading);

  if (unreleasedIndex === -1) {
    const firstVersionIndex = existingContent.indexOf('\n## [');
    if (firstVersionIndex === -1) {
      return `${existingContent.trimEnd()}\n\n${newSection}`;
    }
    return `${existingContent.slice(0, firstVersionIndex + 1)}${newSection}\n${existingContent.slice(firstVersionIndex + 1)}`;
  }

  const nextSectionIndex = existingContent.indexOf(
    '\n## [',
    unreleasedIndex + unreleasedHeading.length,
  );

  if (nextSectionIndex === -1) {
    return `${existingContent.trimEnd()}\n\n${newSection}`;
  }

  return `${existingContent.slice(0, nextSectionIndex + 1)}${newSection}\n${existingContent.slice(nextSectionIndex + 1)}`;
}

export function hasVersionInChangelog(
  changelogContent: string,
  version: string,
): boolean {
  return changelogContent.includes(`## [${version}]`);
}

export function collectCommitLinesSinceTag(
  config: ResolvedReleasePackageConfig,
  fromTag?: string,
): string[] {
  const gitTags = fromTag ? [] : readGitTags();
  const previousTag = fromTag || selectPreviousGitTag(config, gitTags);
  const range = previousTag ? `${previousTag}..HEAD` : 'HEAD';
  const args = [
    'log',
    range,
    '--oneline',
    '--no-merges',
    '--',
    ...config.changelogPaths,
  ];
  const output = runCommand(getGitCommand(), args, {
    cwd: REPO_ROOT,
    logger: ChangelogLogger,
  }).trim();

  if (!output) {
    return [];
  }

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function resolveChangelogBaseTag(
  config: Pick<ReleasePackageConfig, 'tagPrefix' | 'legacyTagPrefix'>,
  tags: string[],
  fromTag?: string,
): string | undefined {
  return fromTag || selectPreviousGitTag(config, tags);
}

export function createReleasePlanFromVersionSelection(
  config: ResolvedReleasePackageConfig,
  selection: PromptVersionSelection,
  options: {
    explicitNpmTag?: string;
  } = {},
): ReleasePlan {
  const currentVersion = config.manifest.version;
  if (!currentVersion) {
    throw new Error(`Package ${config.packageName} is missing a version`);
  }

  const newVersion = resolveNextVersion(currentVersion, selection);
  if (compareVersions(newVersion, currentVersion) <= 0) {
    throw new Error(
      `New version ${newVersion} must be greater than current ${currentVersion}`,
    );
  }

  return {
    config,
    currentVersion,
    newVersion,
    gitTag: createGitTag(config, newVersion),
    npmTag: resolveDefaultNpmTag(
      newVersion,
      options.explicitNpmTag,
      selection.preId,
    ),
  };
}

export function applyPackageVersion(
  config: ResolvedReleasePackageConfig,
  newVersion: string,
): void {
  const nextManifest = {
    ...config.manifest,
    version: newVersion,
  };
  config.manifest = nextManifest;
  writeJsonFile(config.manifestPath, nextManifest);
}

export function writeChangelogForPlan(
  plan: ReleasePlan,
  options: {
    dryRun?: boolean;
    fromTag?: string;
  } = {},
): { content: string; changed: boolean; commitLines: string[] } {
  const { dryRun = false, fromTag } = options;
  const changelogPath = plan.config.changelogPath;
  const commitLines = collectCommitLinesSinceTag(plan.config, fromTag);
  const nextSection = buildChangelogSection(plan.newVersion, commitLines);

  const existingContent = existsSync(changelogPath)
    ? readFileSync(changelogPath, 'utf8')
    : createEmptyChangelogTemplate();

  if (hasVersionInChangelog(existingContent, plan.newVersion)) {
    ChangelogLogger.info(
      `CHANGELOG already contains ${plan.config.packageName}@${plan.newVersion}, skipping write`,
    );
    return {
      content: existingContent,
      changed: false,
      commitLines,
    };
  }

  const updatedContent = insertChangelogSection(existingContent, nextSection);
  if (!dryRun) {
    writeFileSync(changelogPath, `${updatedContent.trimEnd()}\n`);
  }

  return {
    content: updatedContent,
    changed: true,
    commitLines,
  };
}

async function resolveChangelogPlans(
  options: ChangelogCliOptions,
): Promise<ReleasePlan[]> {
  const availableConfigs = discoverReleasePackages();
  const packageConfigs =
    options.packageSelectors.length > 0
      ? resolvePackageSelections(options.packageSelectors, availableConfigs)
      : process.stdin.isTTY
        ? resolvePackageSelections(
            (
              await promptForPackageSelections(
                availableConfigs,
                'Select package(s) for changelog generation',
              )
            ).packageSelectors,
            availableConfigs,
          )
        : (() => {
            throw new Error(
              'Missing --package. Use --package <name> or run the command in an interactive terminal.',
            );
          })();

  const sortedConfigs = sortReleasePackageConfigs(packageConfigs);
  const plans: ReleasePlan[] = [];

  if (options.version) {
    if (!isValidVersion(options.version)) {
      throw new Error(`Invalid version: ${options.version}`);
    }
    for (const config of sortedConfigs) {
      plans.push(
        createReleasePlanFromVersionSelection(config, {
          mode: 'custom',
          version: options.version,
        }),
      );
    }
    return plans;
  }

  if (options.type) {
    for (const config of sortedConfigs) {
      plans.push(
        createReleasePlanFromVersionSelection(config, {
          mode: options.type,
          preId: options.preId,
        }),
      );
    }
    return plans;
  }

  for (const config of sortedConfigs) {
    const selection = process.stdin.isTTY
      ? await promptForVersionSelection(config)
      : ({
          mode: 'patch',
        } satisfies PromptVersionSelection);
    plans.push(createReleasePlanFromVersionSelection(config, selection));
  }

  return plans;
}
export async function runChangelogCommand(
  options: ChangelogCliOptions,
): Promise<void> {
  const plans = await resolveChangelogPlans(options);
  ChangelogLogger.info(
    `Preparing changelog updates:\n${formatReleasePlans(plans)}`,
  );
  ChangelogLogger.info('changelog update started');
  const changelogElapsed = createElapsedTimer();

  for (const plan of plans) {
    const result = writeChangelogForPlan(plan, {
      dryRun: options.dryRun,
      fromTag: options.fromTag,
    });
    if (options.dryRun) {
      ChangelogLogger.info(
        [
          `Preview for ${plan.config.packageName}@${plan.newVersion}:`,
          result.changed
            ? result.content
            : `No changelog update needed for ${plan.config.packageName}@${plan.newVersion}.`,
        ].join('\n'),
      );
      continue;
    }

    if (result.changed) {
      ChangelogLogger.success(
        `Updated ${path.relative(REPO_ROOT, plan.config.changelogPath)} for ${plan.config.packageName}@${plan.newVersion}`,
      );
    }
  }
  ChangelogLogger.success('changelog update finished', changelogElapsed());
}
