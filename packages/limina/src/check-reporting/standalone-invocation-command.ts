import type { LiminaConfigLoader } from '#config/runner';
import { normalizeAbsolutePathIdentity } from '#utils/path';
import { Shescape } from 'shescape';

export type GeneratedCommandDialect = 'cmd' | 'posix' | 'powershell';

export interface GlobalQueryCommandContext {
  readonly configLoader: LiminaConfigLoader;
  readonly configPath: string;
  readonly mode: string;
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

export function createGlobalQueryCommandContext(options: {
  configLoader: LiminaConfigLoader;
  configPath: string;
  mode: string;
  workspaceRoot: string;
}): GlobalQueryCommandContext {
  return Object.freeze({
    configLoader: options.configLoader,
    configPath: normalizeAbsolutePathIdentity(options.configPath),
    mode: options.mode,
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
  return Object.freeze([
    'pnpm',
    '--dir',
    generatedCommand.context.workspaceRoot,
    'exec',
    'limina',
    '--config',
    generatedCommand.context.configPath,
    '--config-loader',
    generatedCommand.context.configLoader,
    '--mode',
    generatedCommand.context.mode,
    ...generatedCommand.subcommandTokens,
  ]);
}

export function renderGeneratedLiminaCommand(
  generatedCommand: GeneratedLiminaCommand,
  dialect: GeneratedCommandDialect,
): string {
  const [executable, ...args] =
    getGeneratedLiminaCommandTokens(generatedCommand);
  const shescape = new Shescape({
    flagProtection: false,
    shell: SHELL_BY_DIALECT[dialect],
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
