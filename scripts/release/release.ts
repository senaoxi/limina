import { createElapsedTimer } from 'logaria/helper';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  applyPackageVersion,
  createReleasePlanFromVersionSelection,
  writeChangelogForPlan,
} from './changelog';
import { publishReleaseGroup, validatePublicationTarget } from './publication';
import {
  REPO_ROOT,
  ReleaseLogger,
  createGitTag,
  discoverReleasePackages,
  formatReleasePlans,
  getGitCommand,
  getNpmCommand,
  getPnpmCommand,
  isValidVersion,
  promptForChangelogReview,
  promptForExecutionMode,
  promptForPackageSelections,
  promptForVersionSelection,
  readPublishBranch,
  resolveDefaultNpmTag,
  resolvePackageSelections,
  runCommand,
  sortReleasePackageConfigs,
  type PublishCliOptions,
  type ReleaseCliOptions,
  type ReleasePlan,
  type ResolvedReleasePackageConfig,
} from './shared';

interface ReleaseRunContext {
  options: ReleaseCliOptions;
  plans: ReleasePlan[];
}

interface PublishRunContext {
  options: PublishCliOptions;
  plans: ReleasePlan[];
}

function getPackageScriptRunner(
  config: ResolvedReleasePackageConfig,
  scriptName: string,
  env?: NodeJS.ProcessEnv,
): void {
  ReleaseLogger.info(`Running ${config.packageName}:${scriptName}`);
  runCommand(getPnpmCommand(), ['run', scriptName], {
    cwd: REPO_ROOT,
    env,
    stdio: 'inherit',
    logger: ReleaseLogger,
  });
}

function runPackageBuildTarget(
  config: ResolvedReleasePackageConfig,
  env?: NodeJS.ProcessEnv,
): void {
  getPackageScriptRunner(config, 'build', env);
}

function runPackageArtifactChecks(config: ResolvedReleasePackageConfig): void {
  ReleaseLogger.info(`Running package checks for ${config.packageName}`);
  runCommand(
    getPnpmCommand(),
    [
      'exec',
      'node',
      'packages/limina/bin/limina.js',
      'package',
      'check',
      '--package',
      config.packageName,
    ],
    {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      logger: ReleaseLogger,
    },
  );
}

function runPackageReleaseConsistencyChecks(
  config: ResolvedReleasePackageConfig,
): void {
  ReleaseLogger.info(`Running release checks for ${config.packageName}`);
  runCommand(
    getPnpmCommand(),
    [
      'exec',
      'node',
      'packages/limina/bin/limina.js',
      'release',
      'check',
      '--package',
      config.packageName,
    ],
    {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      logger: ReleaseLogger,
    },
  );
}

function verifyDistVersion(plan: ReleasePlan): void {
  validatePublicationTarget(plan.config, plan.newVersion, plan.gitTag);
}

function runStandardPackageReleaseChecks(
  plan: ReleasePlan,
  options: Pick<
    ReleaseCliOptions | PublishCliOptions,
    'skipBuild' | 'skipTests'
  >,
): void {
  const { config } = plan;

  if (!options.skipTests) {
    getPackageScriptRunner(config, 'test');
    if (config.previewChecks.includes('smoke')) {
      getPackageScriptRunner(config, 'smoke');
    }
  }
  if (!options.skipBuild) {
    runPackageBuildTarget(config);
    verifyDistVersion(plan);
    runPackageArtifactChecks(config);
    runPackageReleaseConsistencyChecks(config);
    runCommand(getNpmCommand(), ['pack', '--dry-run'], {
      cwd: config.publishDir,
      stdio: 'inherit',
      logger: ReleaseLogger,
    });
  }
}

function runPackageReleaseChecks(
  plan: ReleasePlan,
  options: Pick<
    ReleaseCliOptions | PublishCliOptions,
    'skipBuild' | 'skipTests'
  >,
): void {
  runStandardPackageReleaseChecks(plan, options);
}

function ensureWorkingTreeIsClean(options: { dryRun: boolean }): void {
  if (options.dryRun) {
    return;
  }

  const status = runCommand(getGitCommand(), ['status', '--porcelain'], {
    cwd: REPO_ROOT,
    logger: ReleaseLogger,
  }).trim();

  if (status) {
    throw new Error(
      'Working directory is not clean. Commit or stash changes first.',
    );
  }
}

function warnOnBranchMismatch(options: ReleaseCliOptions): void {
  const currentBranch = runCommand(
    getGitCommand(),
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    {
      cwd: REPO_ROOT,
      logger: ReleaseLogger,
    },
  ).trim();
  const publishBranch = readPublishBranch();
  if (!options.dryRun && currentBranch !== publishBranch) {
    ReleaseLogger.warn(
      `Publishing from ${currentBranch} while pnpm-workspace.yaml expects ${publishBranch}`,
    );
  }
}

function checkNpmAuth(options: { dryRun: boolean; provenance: boolean }): void {
  if (options.dryRun) {
    ReleaseLogger.info('Dry-run mode skips npm authentication checks');
    return;
  }

  if (options.provenance && canPublishWithProvenanceInCurrentProcess()) {
    ReleaseLogger.info(
      'Skipping npm whoami because provenance publishing uses CI trusted publishing credentials',
    );
    return;
  }

  runCommand(getNpmCommand(), ['whoami'], {
    cwd: REPO_ROOT,
    logger: ReleaseLogger,
  });
}

function canPublishWithProvenanceInCurrentProcess(): boolean {
  return (
    process.env.GITHUB_ACTIONS === 'true' || process.env.GITLAB_CI === 'true'
  );
}

function hasGitHubActionsIdTokenPermission(): boolean {
  return Boolean(
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL &&
      process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  );
}

function ensureProvenancePublishEnvironment(options: {
  dryRun?: boolean;
  provenance: boolean;
}): void {
  if (options.dryRun || !options.provenance) {
    return;
  }

  if (!canPublishWithProvenanceInCurrentProcess()) {
    throw new Error(
      'npm provenance publishing requires a supported cloud CI/CD environment. Push an approved release tag and manually dispatch the gated GitHub Actions publish workflow, or pass --no-provenance for an intentional non-provenance publish.',
    );
  }

  if (
    process.env.GITHUB_ACTIONS === 'true' &&
    !hasGitHubActionsIdTokenPermission()
  ) {
    throw new Error(
      'npm provenance publishing from GitHub Actions requires permissions.id-token: write.',
    );
  }
}

function shouldPublishNpmInCurrentRelease(options: ReleaseCliOptions): boolean {
  if (options.skipNpmPublish) {
    return false;
  }
  if (!options.provenance) {
    return true;
  }
  return canPublishWithProvenanceInCurrentProcess();
}

function validateReleasePublishPath(options: ReleaseCliOptions): void {
  if (
    options.dryRun ||
    options.skipNpmPublish ||
    shouldPublishNpmInCurrentRelease(options)
  ) {
    return;
  }
  if (options.skipPush) {
    throw new Error(
      'Cannot defer npm provenance publishing while --skip-push is set. Remove --skip-push so the release tag can trigger GitHub Actions, or pass --no-provenance for an intentional local publish.',
    );
  }
}

function getReleaseTagPrefixes(plans: ReleasePlan[]): string[] {
  return [...new Set(plans.map((plan) => plan.config.tagPrefix))];
}

function remoteHasTagPrefix(tagPrefix: string): boolean {
  return Boolean(
    runCommand(
      getGitCommand(),
      ['ls-remote', '--refs', '--tags', 'origin', `${tagPrefix}/*`],
      {
        cwd: REPO_ROOT,
        allowFailure: true,
        logger: ReleaseLogger,
      },
    ).trim(),
  );
}

function refreshGitTags(plans: ReleasePlan[]): void {
  const tagPrefixes = getReleaseTagPrefixes(plans);

  for (const tagPrefix of tagPrefixes) {
    if (!remoteHasTagPrefix(tagPrefix)) {
      ReleaseLogger.info(
        `No remote tags found for ${tagPrefix}/*, skipping tag refresh`,
      );
      continue;
    }

    try {
      runCommand(
        getGitCommand(),
        [
          'fetch',
          'origin',
          '--no-tags',
          `refs/tags/${tagPrefix}/*:refs/tags/${tagPrefix}/*`,
        ],
        {
          cwd: REPO_ROOT,
          logger: ReleaseLogger,
        },
      );
    } catch {
      ReleaseLogger.warn(
        `Failed to refresh remote tags for ${tagPrefix}/*, continuing with local tags`,
      );
    }
  }
}

function warnOnAheadBehind(): void {
  try {
    const upstream = runCommand(
      getGitCommand(),
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
      {
        cwd: REPO_ROOT,
        logger: ReleaseLogger,
      },
    ).trim();
    const [behindCount, aheadCount] = runCommand(
      getGitCommand(),
      ['rev-list', '--left-right', '--count', '@{u}...HEAD'],
      {
        cwd: REPO_ROOT,
        logger: ReleaseLogger,
      },
    )
      .trim()
      .split('\t')
      .map((value) => Number.parseInt(value, 10));

    if (behindCount > 0) {
      ReleaseLogger.warn(
        `Your branch is behind ${upstream} by ${behindCount} commit(s).`,
      );
    }
    if (aheadCount > 0) {
      ReleaseLogger.warn(
        `Your branch is ahead of ${upstream} by ${aheadCount} commit(s).`,
      );
    }
  } catch {
    ReleaseLogger.info(
      'No upstream branch detected, skipping ahead/behind checks',
    );
  }
}

function ensureVersionNotPublished(
  plan: ReleasePlan,
  options: Pick<ReleaseCliOptions | PublishCliOptions, 'dryRun'>,
): void {
  if (options.dryRun) {
    ReleaseLogger.info(
      `Dry-run mode skips npm registry existence checks for ${plan.config.packageName}@${plan.newVersion}`,
    );
    return;
  }

  const publishedVersion = runCommand(
    getNpmCommand(),
    ['view', `${plan.config.packageName}@${plan.newVersion}`, 'version'],
    {
      cwd: REPO_ROOT,
      allowFailure: true,
      logger: ReleaseLogger,
    },
  ).trim();

  if (publishedVersion) {
    throw new Error(
      `Version already exists on npm: ${plan.config.packageName}@${plan.newVersion}`,
    );
  }

  ReleaseLogger.info(
    `Version is available on npm: ${plan.config.packageName}@${plan.newVersion}`,
  );
}

function stageReleaseFiles(context: ReleaseRunContext): void {
  const pathsToStage: string[] = ['pnpm-lock.yaml'];

  for (const plan of context.plans) {
    pathsToStage.push(path.relative(REPO_ROOT, plan.config.manifestPath));
    if (!context.options.skipChangelog) {
      pathsToStage.push(path.relative(REPO_ROOT, plan.config.changelogPath));
    }
  }

  runCommand(getGitCommand(), ['add', '--', ...new Set(pathsToStage)], {
    cwd: REPO_ROOT,
    logger: ReleaseLogger,
  });
}

function createCombinedCommitMessage(plans: ReleasePlan[]): string {
  const summary = plans
    .map((plan) => `${plan.config.key}@${plan.newVersion}`)
    .join(', ');
  return `release: ${summary}`;
}

function createGitTags(context: ReleaseRunContext): void {
  const tagPlans = [
    ...new Map(context.plans.map((plan) => [plan.gitTag, plan])).values(),
  ];
  for (const plan of tagPlans) {
    const tagExists = runCommand(
      getGitCommand(),
      ['tag', '--list', plan.gitTag],
      {
        cwd: REPO_ROOT,
        logger: ReleaseLogger,
      },
    ).trim();
    if (tagExists) {
      throw new Error(`Git tag already exists: ${plan.gitTag}`);
    }
  }

  runCommand(
    getGitCommand(),
    ['commit', '-m', createCombinedCommitMessage(context.plans)],
    {
      cwd: REPO_ROOT,
      logger: ReleaseLogger,
    },
  );

  for (const plan of tagPlans) {
    runCommand(
      getGitCommand(),
      [
        'tag',
        '-a',
        plan.gitTag,
        '-m',
        `Release ${plan.config.packageName}@${plan.newVersion}`,
      ],
      {
        cwd: REPO_ROOT,
        logger: ReleaseLogger,
      },
    );
  }
}

function ensureChangelogReviewPromptIsAvailable(
  context: ReleaseRunContext,
): void {
  if (context.options.skipChangelog || process.stdin.isTTY) {
    return;
  }

  throw new Error(
    'Changelog generation requires manual review in an interactive terminal. Run release in a TTY, or update the changelog first and pass --skip-changelog.',
  );
}

function createPublishPlanFromCurrentVersion(
  config: ResolvedReleasePackageConfig,
  options: Pick<PublishCliOptions, 'npmTag'> = {},
): ReleasePlan {
  const version = config.manifest.version;
  if (!version) {
    throw new Error(`Package ${config.packageName} is missing a version`);
  }

  return {
    config,
    currentVersion: version,
    newVersion: version,
    gitTag: createGitTag(config, version),
    npmTag: resolveDefaultNpmTag(version, options.npmTag),
  };
}

async function resolvePublishPlans(
  options: PublishCliOptions,
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
                'Select package(s) to publish',
              )
            ).packageSelectors,
            availableConfigs,
          )
        : (() => {
            throw new Error(
              'Missing --package. Use --package <name> or run the command in an interactive terminal.',
            );
          })();

  return sortReleasePackageConfigs(packageConfigs).map((config) =>
    createPublishPlanFromCurrentVersion(config, {
      npmTag: options.npmTag,
    }),
  );
}

function previewPublishPlan(context: PublishRunContext): void {
  ReleaseLogger.info(
    [
      context.options.dryRun ? 'Dry-run publish plan:' : 'Publish plan:',
      formatReleasePlans(context.plans),
      '',
      `npm provenance: ${context.options.provenance ? 'enabled' : 'disabled'}`,
      context.options.dryRun
        ? 'Dry-run mode only previews the plan. No packages will be published.'
        : 'The packages above will now be checked and published.',
    ].join('\n'),
  );
}

function pushRelease(context: ReleaseRunContext): void {
  if (context.options.skipPush) {
    ReleaseLogger.info('Skipping git push as requested');
    return;
  }

  runCommand(getGitCommand(), ['push', 'origin', '--follow-tags'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    logger: ReleaseLogger,
  });
}

async function resolveReleasePlans(options: ReleaseCliOptions): Promise<{
  plans: ReleasePlan[];
  options: ReleaseCliOptions;
}> {
  const availableConfigs = discoverReleasePackages();
  let usedInteractivePrompts = false;

  const packageConfigs =
    options.packageSelectors.length > 0
      ? resolvePackageSelections(options.packageSelectors, availableConfigs)
      : process.stdin.isTTY
        ? (() => {
            usedInteractivePrompts = true;
            return promptForPackageSelections(
              availableConfigs,
              'Select package(s) to release',
            );
          })()
        : (() => {
            throw new Error(
              'Missing --package. Use --package <name> or run the command in an interactive terminal.',
            );
          })();

  const resolvedPackageConfigs = Array.isArray(packageConfigs)
    ? packageConfigs
    : resolvePackageSelections(
        (await packageConfigs).packageSelectors,
        availableConfigs,
      );
  const sortedConfigs = sortReleasePackageConfigs(resolvedPackageConfigs);
  const plans: ReleasePlan[] = [];

  if (options.version) {
    if (!isValidVersion(options.version)) {
      throw new Error(`Invalid version: ${options.version}`);
    }
    for (const config of sortedConfigs) {
      plans.push(
        createReleasePlanFromVersionSelection(
          config,
          {
            mode: 'custom',
            version: options.version,
          },
          {
            explicitNpmTag: options.npmTag,
          },
        ),
      );
    }
  } else if (options.type) {
    for (const config of sortedConfigs) {
      plans.push(
        createReleasePlanFromVersionSelection(
          config,
          {
            mode: options.type,
            preId: options.preId,
          },
          {
            explicitNpmTag: options.npmTag,
          },
        ),
      );
    }
  } else if (process.stdin.isTTY) {
    usedInteractivePrompts = true;
    const selection = await promptForVersionSelection(sortedConfigs[0]!);
    for (const config of sortedConfigs) {
      plans.push(
        createReleasePlanFromVersionSelection(config, selection, {
          explicitNpmTag: options.npmTag,
        }),
      );
    }
  } else {
    throw new Error(
      'Missing version information. Use --type/--version or run in an interactive terminal.',
    );
  }

  if (usedInteractivePrompts && !options.yes) {
    const executionMode = await promptForExecutionMode();
    if (!executionMode.confirmed) {
      throw new Error('Release cancelled');
    }
    options.dryRun = executionMode.dryRun;
  }

  return {
    plans,
    options,
  };
}

function previewReleasePlan(context: ReleaseRunContext): void {
  const npmPublishMode = context.options.skipNpmPublish
    ? 'skipped by --skip-npm-publish'
    : shouldPublishNpmInCurrentRelease(context.options)
      ? context.options.provenance
        ? 'current process with provenance'
        : 'current process without provenance'
      : 'deferred to the manually dispatched Publish Limina workflow for provenance';
  const githubReleaseMode =
    'not automated; prepare separately after publication';

  ReleaseLogger.info(
    [
      context.options.dryRun
        ? 'Dry-run release plan:'
        : 'Release execution plan:',
      formatReleasePlans(context.plans),
      '',
      `npm publish: ${npmPublishMode}`,
      `GitHub release: ${githubReleaseMode}`,
      context.options.dryRun
        ? 'Dry-run mode only previews the plan. No files will be changed and no publish steps will run.'
        : 'The steps above will now be executed in order.',
    ].join('\n'),
  );
}

function prepareReleaseFiles(context: ReleaseRunContext): {
  changelogReviewPlans: ReleasePlan[];
} {
  const changelogReviewPlans: ReleasePlan[] = [];

  for (const plan of context.plans) {
    applyPackageVersion(plan.config, plan.newVersion);
    if (!context.options.skipChangelog) {
      const changelogResult = writeChangelogForPlan(plan, {
        fromTag: context.options.fromTag,
      });
      if (changelogResult.changed) {
        changelogReviewPlans.push(plan);
      }
    }
  }

  runCommand(getPnpmCommand(), ['install', '--lockfile-only'], {
    cwd: REPO_ROOT,
    logger: ReleaseLogger,
  });
  runCommand(
    getPnpmCommand(),
    ['exec', 'prettier', '--write', 'pnpm-lock.yaml'],
    { cwd: REPO_ROOT, logger: ReleaseLogger },
  );
  runCommand(getPnpmCommand(), ['install', '--frozen-lockfile'], {
    cwd: REPO_ROOT,
    logger: ReleaseLogger,
  });
  return { changelogReviewPlans };
}

function performPreflightChecks(context: ReleaseRunContext): void {
  const publishInCurrentProcess = shouldPublishNpmInCurrentRelease(
    context.options,
  );

  ensureWorkingTreeIsClean(context.options);
  warnOnBranchMismatch(context.options);
  validateReleasePublishPath(context.options);
  if (publishInCurrentProcess) {
    ensureProvenancePublishEnvironment(context.options);
    checkNpmAuth(context.options);
  } else {
    ReleaseLogger.info(
      'Skipping npm authentication checks because npm publish is deferred to GitHub Actions',
    );
  }
  refreshGitTags(context.plans);
  warnOnAheadBehind();

  for (const plan of context.plans) {
    ensureVersionNotPublished(plan, context.options);
  }
}

function performPublishPreflightChecks(context: PublishRunContext): void {
  ensureWorkingTreeIsClean(context.options);
  ensureProvenancePublishEnvironment(context.options);
  checkNpmAuth(context.options);
}

export async function runPublishCommand(
  options: PublishCliOptions,
): Promise<void> {
  const plans = await resolvePublishPlans(options);
  const context: PublishRunContext = { plans, options };

  previewPublishPlan(context);

  if (context.options.dryRun) {
    return;
  }

  assertReleaseEnabled();
  ReleaseLogger.info('publish started');
  const publishElapsed = createElapsedTimer();
  performPublishPreflightChecks(context);

  for (const plan of context.plans) {
    runPackageReleaseChecks(plan, context.options);
  }
  publishReleaseGroup(context.plans, context.options);

  ReleaseLogger.success(
    `Publish completed: ${context.plans
      .map((plan) => `${plan.config.packageName}@${plan.newVersion}`)
      .join(', ')}`,
    publishElapsed(),
  );
}

export async function runReleaseCommand(
  options: ReleaseCliOptions,
): Promise<void> {
  const { plans } = await resolveReleasePlans(options);
  const context: ReleaseRunContext = { plans, options };

  previewReleasePlan(context);

  if (context.options.dryRun) {
    return;
  }

  assertReleaseEnabled();
  ReleaseLogger.info('release started');
  const releaseElapsed = createElapsedTimer();
  ensureChangelogReviewPromptIsAvailable(context);
  performPreflightChecks(context);
  const { changelogReviewPlans } = prepareReleaseFiles(context);

  if (changelogReviewPlans.length > 0) {
    await promptForChangelogReview(changelogReviewPlans);
  }

  for (const plan of context.plans) {
    runPackageReleaseChecks(plan, context.options);
  }

  stageReleaseFiles(context);
  createGitTags(context);

  if (shouldPublishNpmInCurrentRelease(context.options)) {
    publishReleaseGroup(context.plans, context.options);
  } else {
    ReleaseLogger.info(
      'Skipping local npm publish. After pushing the approved tag, manually dispatch the gated Publish Limina workflow.',
    );
  }

  pushRelease(context);

  ReleaseLogger.success(
    `Release completed: ${context.plans
      .map((plan) => `${plan.config.packageName}@${plan.newVersion}`)
      .join(', ')}`,
    releaseElapsed(),
  );
}

function assertReleaseEnabled(): void {
  const hasTemporaryLink = [
    'package.json',
    'packages/limina/package.json',
    'packages/build-tools/package.json',
  ].some((manifestPath) => {
    const manifest = JSON.parse(
      readFileSync(path.join(REPO_ROOT, manifestPath), 'utf8'),
    ) as { devDependencies?: Record<string, string> };
    return manifest.devDependencies?.logaria?.startsWith('link:');
  });
  if (process.env.LIMINA_RELEASE_ENABLED !== '1' || hasTemporaryLink) {
    throw new Error(
      'Release is closed until independent Logaria consumption, remote CI and the publisher cutover are approved.',
    );
  }
}
