import { cac } from 'cac';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import package_ from '../package.json' with { type: 'json' };
import { migrationBuildInfo } from './build-info';
import { reportRuntimeObservations } from './runtime-observation';
import { assertRuntimeVersion } from './runtime-version';

interface MigrationFlags {
  config?: string;
  configLoader?: string;
  mode?: string;
}

function configErrorCauses(error: unknown): Error[] {
  const causes = new Set<Error>();
  let cause: unknown = error;
  while (cause instanceof Error) {
    if (causes.has(cause)) break;
    causes.add(cause);
    cause = cause.cause;
  }
  return [...causes];
}

function hasMissingPackageCode(error: Error): boolean {
  return (
    'code' in error &&
    ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(String(error.code))
  );
}

function isMissingPublicLimina(error: Error): boolean {
  return (
    hasMissingPackageCode(error) &&
    /Cannot find (?:package|module) ['"]limina['"]/u.test(error.message)
  );
}

function isMissingConfig(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.toLowerCase().includes('unable to find limina config')
  );
}

function rethrowMigrationConfigError(error: unknown): never {
  if (configErrorCauses(error).some(isMissingPublicLimina))
    throw new Error(
      'The Limina config imports the public "limina" package, but it is not installed where that config resolves dependencies. Install Limina in the project before migrating. limina-migrate embeds its input implementation; it does not supply or rewrite user config imports.',
      { cause: error },
    );
  if (isMissingConfig(error)) {
    throw new Error(
      'Run npx limina init first, then rerun npx limina-migrate.',
      { cause: error },
    );
  }
  throw error;
}

async function runMigrationAction(flags: MigrationFlags): Promise<void> {
  assertRuntimeVersion();
  const {
    clearCliScreen,
    createCliFlow,
    loadConfig,
    parseConfigLoader,
    runCliFlowWithCleanup,
  } = await import('limina/internal/migration');
  const { runMigration } = await import('./migration');
  clearCliScreen();
  const flow = createCliFlow();
  const isPassed = await runCliFlowWithCleanup(
    flow,
    {
      failed: 'limina-migrate failed',
      passed: `limina-migrate passed (embedded Limina@${migrationBuildInfo.coreVersion} inputs)`,
    },
    async () => {
      flow.intro('limina-migrate');
      const configLoader = parseConfigLoader(flags.configLoader);
      let config: Awaited<ReturnType<typeof loadConfig>>;
      try {
        config = await loadConfig({
          command: 'migration',
          configLoader,
          configPath: flags.config,
          cwd: process.cwd(),
          mode: flags.mode,
        });
      } catch (error) {
        rethrowMigrationConfigError(error);
      }
      reportRuntimeObservations(config, flow);
      const result = await runMigration(config, {
        flow,
        flowDepth: 1,
        configLoader,
        mode: flags.mode,
      });
      return result.inputConsumable && result.incompleteFiles.length === 0;
    },
  );
  if (!isPassed) process.exitCode = 1;
}

export function createMigrationCli(): ReturnType<typeof cac> {
  const cli = cac('limina-migrate');
  cli.version(package_.version).help();
  cli.option('--config <path>', 'Path to a Limina config file');
  cli.option('--config-loader <loader>', 'Config loader to use: native, tsx');
  cli.option('--mode <mode>', 'Mode passed to limina config functions');
  cli
    .command('', 'Migrate TypeScript configs into Limina governance')
    .action(runMigrationAction);
  return cli;
}

function assertNoArguments(arguments_: readonly string[]): void {
  if (arguments_.length > 0)
    throw new Error(`Unexpected argument: ${arguments_[0]}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectExecution(): boolean {
  const invocation = process.argv[1];
  return (
    invocation !== undefined &&
    nodePath.resolve(invocation) === fileURLToPath(import.meta.url)
  );
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  try {
    const cli = createMigrationCli();
    cli.parse(argv, { run: false });
    assertNoArguments(cli.args);
    await cli.runMatchedCommand();
  } catch (error) {
    process.stderr.write(`limina-migrate failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

if (isDirectExecution()) await runCli();
