#!/usr/bin/env node
import { cac } from 'cac';
import { runGraphCheck, runGraphSync } from './commands/graph';
import { runInit } from './commands/init';
import { runNx } from './commands/nx';
import { runPackageCheck } from './commands/package';
import { runPaths } from './commands/paths';
import { runProofCheck } from './commands/proof';
import { runReleaseCheck } from './commands/release';
import { runSourceCheck } from './commands/source';
import { runCheckerBuild, runCheckerTypecheck } from './commands/typecheck';
import {
  type LiminaCommand,
  loadConfig,
  type PackageAttwProfile,
  type PackageCheckToolSelection,
  type ResolvedLiminaConfig,
} from './config';
import { createLiminaFlowReporter } from './flow';
import { clearCliScreen, CliLogger, formatErrorMessage } from './logger';
import { runDefaultCheck, runPipeline } from './pipeline';

interface GlobalFlags {
  config?: string;
  mode?: string;
}

interface PackageSelectionFlags {
  package?: string | string[];
}

interface CheckFlags extends GlobalFlags, PackageSelectionFlags {}

interface PackageFlags extends GlobalFlags, PackageSelectionFlags {
  attwProfile?: string;
  tool?: string;
}

type CheckerFlags = GlobalFlags;

interface InitFlags {
  yes?: boolean;
}

async function load(
  flags: GlobalFlags,
  command: LiminaCommand,
): Promise<ResolvedLiminaConfig> {
  return loadConfig({
    command,
    configPath: flags.config,
    cwd: process.cwd(),
    mode: flags.mode,
  });
}

function parsePackageTool(
  tool: string | undefined,
): PackageCheckToolSelection | undefined {
  if (!tool) {
    return undefined;
  }

  if (
    tool === 'all' ||
    tool === 'publint' ||
    tool === 'attw' ||
    tool === 'boundary'
  ) {
    return tool;
  }

  throw new Error(
    `Invalid package check --tool "${tool}". Expected one of: all, publint, attw, boundary.`,
  );
}

function parsePackageAttwProfile(
  profile: string | undefined,
): PackageAttwProfile | undefined {
  if (!profile) {
    return undefined;
  }

  if (profile === 'strict' || profile === 'node16' || profile === 'esm-only') {
    return profile;
  }

  throw new Error(
    `Invalid package check --attw-profile "${profile}". Expected one of: strict, node16, esm-only.`,
  );
}

function parsePackageNames(
  packageName: string | string[] | undefined,
): string[] | undefined {
  if (!packageName) {
    return undefined;
  }

  const packageNames = (
    Array.isArray(packageName) ? packageName : [packageName]
  )
    .map((name) => name.trim())
    .filter(Boolean);

  return packageNames.length > 0 ? packageNames : undefined;
}

function createCliFlow() {
  clearCliScreen();

  return createLiminaFlowReporter();
}

async function main(): Promise<void> {
  const cli = cac('limina');

  cli.option('--config <path>', 'Path to limina.config.mjs');
  cli.option('--mode <mode>', 'Mode passed to limina config functions');
  cli.help();

  cli
    .command('init', 'Initialize Limina files for a pnpm workspace')
    .option('--yes', 'Accept all init prompts')
    .action(async (flags: InitFlags) => {
      const flow = createCliFlow();
      flow.intro('limina init');
      await runInit({
        clearScreen: false,
        cwd: process.cwd(),
        flow,
        yes: flags.yes,
      });
      flow.outro('limina init finished');
    });

  cli
    .command(
      'check [pipeline]',
      'Run the default check or a configured pipeline',
    )
    .option(
      '-p, --package <name>',
      'Run package-aware pipeline tasks for one package entry',
    )
    .action(async (pipeline: string | undefined, flags: CheckFlags) => {
      const flow = createCliFlow();
      flow.intro('limina check');
      const config = await load(flags, 'check');
      const passed = pipeline
        ? await runPipeline(config, pipeline, {
            cwd: process.cwd(),
            flow,
            packageNames: parsePackageNames(flags.package),
          })
        : await runDefaultCheck(config, {
            cwd: process.cwd(),
            flow,
          });

      if (!passed) {
        process.exitCode = 1;
      }

      flow.outro(passed ? 'limina check passed' : 'limina check failed');
    });

  cli
    .command(
      'paths <action>',
      'Generate source paths for workspace dependency artifact exports',
    )
    .action(async (action: string, flags: GlobalFlags) => {
      if (action !== 'generate' && action !== 'apply' && action !== 'check') {
        throw new Error(
          `Unknown paths action "${action}". Expected generate, apply, or check.`,
        );
      }
      const flow = createCliFlow();
      flow.intro(`limina paths ${action}`);
      const config = await load(flags, 'paths');
      const result = await runPaths(config, {
        check: action === 'check',
        clearScreen: false,
        flow,
      });

      if (action === 'check' && result.changed) {
        process.exitCode = 1;
      }

      flow.outro(
        action === 'check' && result.changed
          ? 'limina paths failed'
          : 'limina paths passed',
      );
    });

  cli
    .command(
      'nx <action> [...targets]',
      'Sync or check Nx project target dependencies from workspace artifact dependencies',
    )
    .action(
      async (
        action: string,
        targets: string[] | undefined,
        flags: GlobalFlags,
      ) => {
        if (action !== 'sync' && action !== 'check') {
          throw new Error(
            `Unknown nx action "${action}". Expected sync or check.`,
          );
        }

        const flow = createCliFlow();
        flow.intro(`limina nx ${action}`);
        const config = await load(flags, 'nx');
        const result = await runNx(config, {
          check: action === 'check',
          clearScreen: false,
          flow,
          targets,
        });

        if (action === 'check' && result.changed) {
          process.exitCode = 1;
        }

        flow.outro(
          action === 'check' && result.changed
            ? 'limina nx failed'
            : 'limina nx passed',
        );
      },
    );

  cli
    .command(
      'graph <action> [entryPath]',
      'Check or sync TypeScript graph architecture',
    )
    .action(
      async (
        action: string,
        entryPath: string | undefined,
        flags: GlobalFlags,
      ) => {
        if (action !== 'check' && action !== 'sync') {
          throw new Error(
            `Unknown graph action "${action}". Expected check or sync.`,
          );
        }
        const flow = createCliFlow();
        flow.intro(`limina graph ${action}`);
        const config = await load(flags, 'graph');

        if (action === 'check') {
          const passed = await runGraphCheck(config, {
            clearScreen: false,
            flow,
          });

          if (!passed) {
            process.exitCode = 1;
          }

          flow.outro(passed ? 'limina graph passed' : 'limina graph failed');
          return;
        }

        try {
          await runGraphSync(config, {
            clearScreen: false,
            cwd: process.cwd(),
            entryPath,
            flow,
          });
        } catch (error) {
          process.exitCode = 1;
          flow.outro('limina graph failed');
          throw error;
        }

        flow.outro('limina graph passed');
      },
    );

  cli
    .command('proof <action>', 'Check root typecheck coverage proof')
    .action(async (action: string, flags: GlobalFlags) => {
      if (action !== 'check') {
        throw new Error(`Unknown proof action "${action}". Expected check.`);
      }
      const flow = createCliFlow();
      flow.intro('limina proof check');
      const config = await load(flags, 'proof');
      const passed = await runProofCheck(config, {
        clearScreen: false,
        flow,
      });

      if (!passed) {
        process.exitCode = 1;
      }

      flow.outro(passed ? 'limina proof passed' : 'limina proof failed');
    });

  cli
    .command('source <action>', 'Check source package boundaries')
    .action(async (action: string, flags: GlobalFlags) => {
      if (action !== 'check') {
        throw new Error(`Unknown source action "${action}". Expected check.`);
      }
      const flow = createCliFlow();
      flow.intro('limina source check');
      const config = await load(flags, 'source');
      const passed = await runSourceCheck(config, {
        clearScreen: false,
        flow,
      });

      if (!passed) {
        process.exitCode = 1;
      }

      flow.outro(passed ? 'limina source passed' : 'limina source failed');
    });

  cli
    .command(
      'checker <action>',
      'Run configured checker build or typecheck entries',
    )
    .action(async (action: string, flags: CheckerFlags) => {
      if (action !== 'typecheck' && action !== 'build') {
        throw new Error(
          `Unknown checker action "${action}". Expected build or typecheck.`,
        );
      }

      const flow = createCliFlow();
      flow.intro(`limina checker ${action}`);

      if (action === 'build') {
        const config = await load(flags, 'check');
        const result = await runCheckerBuild({
          clearScreen: false,
          config,
          cwd: process.cwd(),
          flow,
        });

        if (!result.passed) {
          process.exitCode = 1;
        }

        flow.outro(
          result.passed ? 'limina checker passed' : 'limina checker failed',
        );

        return;
      }

      const config = await load(flags, 'check');
      const result = await runCheckerTypecheck({
        clearScreen: false,
        config,
        cwd: process.cwd(),
        flow,
      });

      if (!result.passed) {
        process.exitCode = 1;
      }

      flow.outro(
        result.passed ? 'limina checker passed' : 'limina checker failed',
      );
    });

  cli
    .command('package <action>', 'Check configured published package outputs')
    .option('-p, --package <name>', 'Run one package check entry')
    .option('--tool <tool>', 'Run one package check tool')
    .option('--attw-profile <profile>', 'Override the configured ATTW profile')
    .action(async (action: string, flags: PackageFlags) => {
      if (action !== 'check') {
        throw new Error(`Unknown package action "${action}". Expected check.`);
      }
      const flow = createCliFlow();
      flow.intro('limina package check');
      const config = await load(flags, 'package');
      const passed = await runPackageCheck({
        attwProfile: parsePackageAttwProfile(flags.attwProfile),
        clearScreen: false,
        config,
        cwd: process.cwd(),
        flow,
        packageNames: parsePackageNames(flags.package),
        tool: parsePackageTool(flags.tool),
      });

      if (!passed) {
        process.exitCode = 1;
      }

      flow.outro(passed ? 'limina package passed' : 'limina package failed');
    });

  cli
    .command('release <action>', 'Check package release readiness')
    .option('-p, --package <name>', 'Run one release check package entry')
    .action(async (action: string, flags: CheckFlags) => {
      if (action !== 'check') {
        throw new Error(`Unknown release action "${action}". Expected check.`);
      }
      const flow = createCliFlow();
      flow.intro('limina release check');
      const config = await load(flags, 'release');
      const passed = await runReleaseCheck({
        clearScreen: false,
        config,
        cwd: process.cwd(),
        flow,
        packageNames: parsePackageNames(flags.package),
      });

      if (!passed) {
        process.exitCode = 1;
      }

      flow.outro(passed ? 'limina release passed' : 'limina release failed');
    });

  cli.parse(process.argv, { run: false });

  try {
    await cli.runMatchedCommand();
  } catch (error) {
    CliLogger.error(`limina failed: ${formatErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

await main();
