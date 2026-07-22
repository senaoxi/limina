import type { LiminaConfigLoader } from '#config/runner';
import { normalizeAbsolutePathIdentity } from '#utils/path';
import { Buffer } from 'node:buffer';
import { Shescape } from 'shescape';

export type GeneratedCommandDialect = 'cmd' | 'posix' | 'powershell';

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
  readonly label: 'PowerShell' | 'Query' | 'cmd.exe (/V:OFF)';
}

const SHESCAPE_SHELL_BY_DIALECT = {
  cmd: 'cmd.exe',
  posix: 'bash',
} as const;
const POWERSHELL_NODE_ARGV_RUNNER = [
  "const p=JSON.parse(Buffer.from(process.argv[1],'base64').toString())",
  "const r=require('node:child_process').spawnSync(process.execPath,p,{stdio:'inherit'})",
  'if(r.error)throw r.error',
  'process.exitCode=r.status??1',
].join(';');

function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
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
  dialect: GeneratedCommandDialect,
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

  if (dialect !== 'posix') {
    return Object.freeze([
      generatedCommand.context.nodeExecutablePath,
      generatedCommand.context.cliEntryPath,
      ...queryArgs,
    ]);
  }

  return Object.freeze([
    'pnpm',
    '--dir',
    generatedCommand.context.workspaceRoot,
    'exec',
    'limina',
    ...queryArgs,
  ]);
}

export function renderGeneratedLiminaCommand(
  generatedCommand: GeneratedLiminaCommand,
  dialect: GeneratedCommandDialect,
): string {
  const [executable, ...args] = getGeneratedLiminaCommandTokens(
    generatedCommand,
    dialect,
  );
  if (dialect === 'cmd') {
    const shescape = new Shescape({
      flagProtection: false,
      shell: SHESCAPE_SHELL_BY_DIALECT.cmd,
    });

    return [
      'cd',
      '/d',
      shescape.quote(generatedCommand.context.workspaceRoot),
      '&&',
      ...shescape.quoteAll([executable, ...args]),
    ].join(' ');
  }

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

  const shescape = new Shescape({
    flagProtection: false,
    shell: SHESCAPE_SHELL_BY_DIALECT.posix,
  });

  return [executable, ...shescape.quoteAll(args)].join(' ');
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
        Object.freeze({
          dialect: 'cmd' as const,
          label: 'cmd.exe (/V:OFF)' as const,
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
