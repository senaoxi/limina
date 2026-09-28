import type { LiminaConfigLoader } from '#config/runner';
import { normalizeAbsolutePathIdentity } from '#utils/path';
import { Buffer } from 'node:buffer';
import quotePosix from 'shell-quote/quote.js';

export type GeneratedCommandDialect = 'posix' | 'powershell';

export interface GlobalQueryCommandContext {
  readonly cliEntryPath: string;
  readonly configLoader: LiminaConfigLoader;
  readonly configPath: string;
  readonly mode: string;
  readonly nodeExecutablePath: string;
  readonly workspaceRoot: string;
}

export interface GeneratedLiminaCommand {
  readonly context: GlobalQueryCommandContext;
  readonly subcommandTokens: readonly [
    'check',
    '--issues',
    '--invocation',
    string,
  ];
}

export interface GeneratedCommandVariant {
  readonly command: string;
  readonly dialect: GeneratedCommandDialect;
  readonly label: 'PowerShell' | 'Query';
}

const POWERSHELL_NODE_ARGV_RUNNER = [
  "const p=JSON.parse(Buffer.from(process.argv[1],'base64').toString())",
  "const r=require('node:child_process').spawnSync(process.execPath,[...p,...process.argv.slice(2)],{stdio:'inherit'})",
  'if(r.error)throw r.error',
  'process.exitCode=r.status??1',
].join(';');

function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quotePosixArgument(value: string): string {
  // shell-quote 1.10 escapes ! inside double quotes, where POSIX shells keep
  // the backslash. Quote the pieces separately and concatenate them into one
  // shell word so literal ! is always escaped outside quotes by the library.
  return value
    .split('!')
    .map((part) => quotePosix([part]))
    .join(quotePosix(['!']));
}

export function createPowerShellNodeTransportTokens(
  nodeExecutablePath: string,
  nodeArgs: readonly string[],
): readonly [string, '-e', string, string] {
  return Object.freeze([
    nodeExecutablePath,
    '-e',
    POWERSHELL_NODE_ARGV_RUNNER,
    Buffer.from(JSON.stringify(nodeArgs), 'utf8').toString('base64'),
  ] as const);
}

export function createGlobalQueryCommandContext(options: {
  cliEntryPath: string;
  configLoader: LiminaConfigLoader;
  configPath: string;
  mode: string;
  nodeExecutablePath: string;
  workspaceRoot: string;
}): GlobalQueryCommandContext {
  return Object.freeze({
    cliEntryPath: normalizeAbsolutePathIdentity(options.cliEntryPath),
    configLoader: options.configLoader,
    configPath: normalizeAbsolutePathIdentity(options.configPath),
    mode: options.mode,
    nodeExecutablePath: normalizeAbsolutePathIdentity(
      options.nodeExecutablePath,
    ),
    workspaceRoot: normalizeAbsolutePathIdentity(options.workspaceRoot),
  });
}

export function createStandaloneInvocationCommand(
  context: GlobalQueryCommandContext,
  invocationId: string,
): GeneratedLiminaCommand {
  return Object.freeze({
    context,
    subcommandTokens: Object.freeze([
      'check',
      '--issues',
      '--invocation',
      invocationId,
    ] as const),
  });
}

export function getGeneratedLiminaCommandTokens(
  generatedCommand: GeneratedLiminaCommand,
): readonly string[] {
  const queryArgs = [
    '--config',
    generatedCommand.context.configPath,
    '--config-loader',
    generatedCommand.context.configLoader,
    '--mode',
    generatedCommand.context.mode,
    ...generatedCommand.subcommandTokens,
  ] as const;

  return Object.freeze([
    generatedCommand.context.nodeExecutablePath,
    generatedCommand.context.cliEntryPath,
    ...queryArgs,
  ]);
}

export function renderGeneratedLiminaCommand(
  generatedCommand: GeneratedLiminaCommand,
  dialect: GeneratedCommandDialect,
): string {
  const [executable, ...args] =
    getGeneratedLiminaCommandTokens(generatedCommand);
  if (dialect === 'powershell') {
    // Windows PowerShell 5.1 and PowerShell 7 marshal native arguments
    // differently. Carry the canonical Node argv as Base64 JSON through a
    // metacharacter-free argument, then reconstruct it in Node and spawn the
    // installed Limina entry without another shell parsing pass.
    const transportTokens = createPowerShellNodeTransportTokens(
      executable,
      args,
    );

    return [
      'Set-Location',
      '-LiteralPath',
      quotePowerShellLiteral(generatedCommand.context.workspaceRoot),
      '-ErrorAction',
      'Stop;',
      '&',
      ...transportTokens.map(quotePowerShellLiteral),
    ].join(' ');
  }

  return [executable, ...args].map(quotePosixArgument).join(' ');
}

export function getGeneratedCommandPresentation(
  platform: NodeJS.Platform = process.platform,
): readonly Pick<GeneratedCommandVariant, 'dialect' | 'label'>[] {
  return platform === 'win32'
    ? Object.freeze([
        Object.freeze({
          dialect: 'powershell' as const,
          label: 'PowerShell' as const,
        }),
      ])
    : Object.freeze([
        Object.freeze({ dialect: 'posix' as const, label: 'Query' as const }),
      ]);
}

export function renderGeneratedCommandVariants(
  generatedCommand: GeneratedLiminaCommand,
  platform: NodeJS.Platform = process.platform,
): readonly GeneratedCommandVariant[] {
  return Object.freeze(
    getGeneratedCommandPresentation(platform).map(({ dialect, label }) =>
      Object.freeze({
        command: renderGeneratedLiminaCommand(generatedCommand, dialect),
        dialect,
        label,
      }),
    ),
  );
}
