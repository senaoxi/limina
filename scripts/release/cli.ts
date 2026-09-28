import { cac } from 'cac';
import { createElapsedTimer, formatErrorMessage } from 'logaria/helper';
import process from 'node:process';
import { runChangelogCommand } from './changelog';
import { runPublishCommand, runReleaseCommand } from './release';
import {
  ChangelogLogger,
  ReleaseLogger,
  isReleaseType,
  splitCsvValues,
  type ChangelogCliOptions,
  type PublishCliOptions,
  type ReleaseCliOptions,
  type ReleaseType,
} from './shared';

type RepeatableStringOption = string | string[] | undefined;
type PositionalArgs = string | string[] | undefined;

interface BaseCliFlags {
  '--'?: string[];
  help?: boolean;
}

interface ReleaseCommandFlags extends BaseCliFlags {
  package?: RepeatableStringOption;
  type?: string;
  version?: string;
  preid?: string;
  dryRun?: boolean;
  yes?: boolean;
  skipTests?: boolean;
  skipBuild?: boolean;
  skipChangelog?: boolean;
  skipNpmPublish?: boolean;
  skipPush?: boolean;
  fromTag?: string;
  registry?: string;
  npmTag?: string;
  provenance?: boolean;
}

interface PublishCommandFlags extends BaseCliFlags {
  package?: RepeatableStringOption;
  dryRun?: boolean;
  skipTests?: boolean;
  skipBuild?: boolean;
  registry?: string;
  npmTag?: string;
  provenance?: boolean;
}

interface ChangelogCommandFlags extends BaseCliFlags {
  package?: RepeatableStringOption;
  type?: string;
  version?: string;
  preid?: string;
  dryRun?: boolean;
  fromTag?: string;
}

function toRawArgv(commandName: string, argv: string[]): string[] {
  return [process.execPath, commandName, ...argv];
}

function normalizeRepeatableOption(
  optionName: string,
  value: RepeatableStringOption,
): string[] {
  if (value === undefined) {
    return [];
  }

  const rawValues = Array.isArray(value) ? value : [value];
  const normalized = rawValues.flatMap(splitCsvValues);
  if (normalized.length === 0) {
    throw new Error(`Missing value for ${optionName}`);
  }

  return normalized;
}

function normalizePositionals(value: PositionalArgs): string[] {
  if (value === undefined) {
    return [];
  }

  return (Array.isArray(value) ? value : [value]).flatMap(splitCsvValues);
}

function normalizeOptionalString(
  optionName: string,
  value: string | undefined,
): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Missing value for ${optionName}`);
  }

  return normalized;
}

function normalizeReleaseType(
  value: string | undefined,
): ReleaseType | undefined {
  const normalized = normalizeOptionalString('--type', value);
  if (!normalized) {
    return undefined;
  }
  if (!isReleaseType(normalized)) {
    throw new Error(
      `Invalid --type value: ${normalized}. Expected patch, minor, major, or prerelease`,
    );
  }
  return normalized;
}

function createReleaseCliOptions(
  positionals: PositionalArgs,
  flags: ReleaseCommandFlags,
): ReleaseCliOptions {
  return {
    packageSelectors: [
      ...normalizePositionals(positionals),
      ...normalizeRepeatableOption('--package', flags.package),
    ],
    type: normalizeReleaseType(flags.type),
    version: normalizeOptionalString('--version', flags.version),
    preId: normalizeOptionalString('--preid', flags.preid),
    dryRun: Boolean(flags.dryRun),
    yes: Boolean(flags.yes),
    skipTests: Boolean(flags.skipTests),
    skipBuild: Boolean(flags.skipBuild),
    skipChangelog: Boolean(flags.skipChangelog),
    skipNpmPublish: Boolean(flags.skipNpmPublish),
    skipPush: Boolean(flags.skipPush),
    fromTag: normalizeOptionalString('--from-tag', flags.fromTag),
    registry: normalizeOptionalString('--registry', flags.registry),
    npmTag: normalizeOptionalString('--npm-tag', flags.npmTag),
    provenance: flags.provenance !== false,
    help: Boolean(flags.help),
  };
}

function createPublishCliOptions(
  positionals: PositionalArgs,
  flags: PublishCommandFlags,
): PublishCliOptions {
  return {
    packageSelectors: [
      ...normalizePositionals(positionals),
      ...normalizeRepeatableOption('--package', flags.package),
    ],
    dryRun: Boolean(flags.dryRun),
    skipTests: Boolean(flags.skipTests),
    skipBuild: Boolean(flags.skipBuild),
    registry: normalizeOptionalString('--registry', flags.registry),
    npmTag: normalizeOptionalString('--npm-tag', flags.npmTag),
    provenance: flags.provenance !== false,
    help: Boolean(flags.help),
  };
}

function createChangelogCliOptions(
  positionals: PositionalArgs,
  flags: ChangelogCommandFlags,
): ChangelogCliOptions {
  return {
    packageSelectors: [
      ...normalizePositionals(positionals),
      ...normalizeRepeatableOption('--package', flags.package),
    ],
    type: normalizeReleaseType(flags.type),
    version: normalizeOptionalString('--version', flags.version),
    preId: normalizeOptionalString('--preid', flags.preid),
    dryRun: Boolean(flags.dryRun),
    fromTag: normalizeOptionalString('--from-tag', flags.fromTag),
    help: Boolean(flags.help),
  };
}

function createReleaseCli() {
  const cli = cac('release');
  cli.help();

  cli
    .command(
      'publish [...packages]',
      'Publish current public package versions to npm',
      {
        ignoreOptionDefaultValue: true,
      },
    )
    .option(
      '-p, --package <name>',
      'Package key or full package name (repeatable or comma-separated)',
    )
    .option('--dry-run', 'Preview the publish plan without publishing')
    .option('--skip-tests', 'Skip package test steps')
    .option('--skip-build', 'Skip package build and verification steps')
    .option('--registry <url>', 'Custom npm registry')
    .option('--npm-tag <tag>', 'Override the npm dist-tag')
    .option('--no-provenance', 'Publish without npm provenance attestations')
    .action(async (packages: string[], flags: PublishCommandFlags) => {
      await runPublishCommand(createPublishCliOptions(packages, flags));
    });

  cli
    .command('[...packages]', 'Release selected public packages', {
      ignoreOptionDefaultValue: true,
    })
    .option(
      '-p, --package <name>',
      'Package key or full package name (repeatable or comma-separated)',
    )
    .option(
      '--type <type>',
      'Version increment type (patch|minor|major|prerelease)',
    )
    .option('--version <version>', 'Specific version to release')
    .option('--preid <id>', 'Prerelease identifier (alpha|beta|rc)')
    .option('--dry-run', 'Preview the release plan without modifying files')
    .option('-y, --yes', 'Skip initial interactive confirmation prompts')
    .option('--skip-tests', 'Skip package test steps')
    .option('--skip-build', 'Skip package build and verification steps')
    .option('--skip-changelog', 'Skip changelog generation')
    .option(
      '--skip-npm-publish',
      'Skip npm publishing after creating the release commit and tags',
    )
    .option('--skip-push', 'Skip pushing commits and tags')
    .option(
      '--from-tag <tag>',
      'Override the starting git tag for changelog collection',
    )
    .option('--registry <url>', 'Custom npm registry')
    .option('--npm-tag <tag>', 'Override the npm dist-tag')
    .option('--no-provenance', 'Publish without npm provenance attestations')
    .action(async (packages: string[], flags: ReleaseCommandFlags) => {
      await runReleaseCommand(createReleaseCliOptions(packages, flags));
    });

  return cli;
}

function createChangelogCli() {
  const cli = cac('changelog');
  cli.help();

  cli
    .command(
      '[...packages]',
      'Generate changelog entries for public packages',
      {
        ignoreOptionDefaultValue: true,
      },
    )
    .option(
      '-p, --package <name>',
      'Package key or full package name (repeatable or comma-separated)',
    )
    .option(
      '--type <type>',
      'Version increment type (patch|minor|major|prerelease)',
    )
    .option('--version <version>', 'Specific version to document')
    .option('--preid <id>', 'Prerelease identifier (alpha|beta|rc)')
    .option(
      '--from-tag <tag>',
      'Override the starting git tag for commit collection',
    )
    .option('--dry-run', 'Preview changelog changes without writing files')
    .action(async (packages: string[], flags: ChangelogCommandFlags) => {
      await runChangelogCommand(createChangelogCliOptions(packages, flags));
    });

  return cli;
}

async function runReleaseCli(rawArgv = process.argv): Promise<void> {
  const cli = createReleaseCli();
  const releaseElapsed = createElapsedTimer();
  try {
    cli.parse(rawArgv, { run: false });
    await cli.runMatchedCommand();
  } catch (error) {
    ReleaseLogger.error(
      `release command failed: ${formatErrorMessage(error)}`,
      releaseElapsed(),
    );
    process.exitCode = 1;
  }
}

async function runChangelogCli(rawArgv = process.argv): Promise<void> {
  const cli = createChangelogCli();
  const changelogElapsed = createElapsedTimer();
  try {
    cli.parse(rawArgv, { run: false });
    await cli.runMatchedCommand();
  } catch (error) {
    ChangelogLogger.error(
      `changelog command failed: ${formatErrorMessage(error)}`,
      changelogElapsed(),
    );
    process.exitCode = 1;
  }
}

export async function mainReleaseCli(
  argv = process.argv.slice(2),
): Promise<void> {
  await runReleaseCli(toRawArgv('release', argv));
}

export async function mainChangelogCli(
  argv = process.argv.slice(2),
): Promise<void> {
  await runChangelogCli(toRawArgv('changelog', argv));
}
