import type { LiminaConfigLoader } from '#config/runner';
import { normalizeAbsolutePathIdentity } from '#utils/path';
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

const SHELL_BY_DIALECT: Readonly<Record<GeneratedCommandDialect, string>> = {
  cmd: 'cmd.exe',
  posix: 'bash',
  powershell: 'powershell.exe',
};
const POWERSHELL_LEGACY_NATIVE_ARGUMENTS =
  "$PSNativeCommandArgumentPassing = 'Legacy';";

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
  const shescape = new Shescape({
    flagProtection: false,
    shell: SHELL_BY_DIALECT[dialect],
  });

  if (dialect === 'cmd') {
    return [
      'cd',
      '/d',
      shescape.quote(generatedCommand.context.workspaceRoot),
      '&&',
      ...shescape.quoteAll([executable, ...args]),
    ].join(' ');
  }

  if (dialect === 'powershell') {
    return [
      'Set-Location',
      '-LiteralPath',
      shescape.quote(generatedCommand.context.workspaceRoot),
      '-ErrorAction',
      'Stop;',
      '&',
      '{',
      // Shescape protects embedded quotes and trailing backslashes for the
      // legacy native argument parser. PowerShell 7.3+ otherwise preserves
      // those protection characters when it invokes node.exe. Keep the
      // preference in a child scope so a pasted query does not change it for
      // later commands in the caller's session.
      POWERSHELL_LEGACY_NATIVE_ARGUMENTS,
      '&',
      ...shescape.quoteAll([executable, ...args]),
      '}',
    ].join(' ');
  }

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
