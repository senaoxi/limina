import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  createGlobalQueryCommandContext,
  createPowerShellNodeTransportTokens,
  createStandaloneInvocationCommand,
  getGeneratedCommandPresentation,
  getGeneratedLiminaCommandTokens,
  renderGeneratedLiminaCommand,
} from '../check-reporting/standalone-invocation-command';

const invocationId = '123e4567-e89b-42d3-a456-426614174000';
const execFileAsync = promisify(execFile);

function createSensitiveCommand() {
  const context = createGlobalQueryCommandContext({
    cliEntryPath: '/opt/limina path/bin/limina.js',
    configLoader: 'tsx',
    configPath: '/tmp/work space/專案 & | < > ^ % ! (x)/limina\'"config.mjs\\',
    mode: 'ci \' " & | < > ^ % ! ( ) \\ tail\\',
    nodeExecutablePath: '/opt/node path/bin/node',
    workspaceRoot: '/tmp/work space/專案 & ^ % ! (x)/',
  });

  return {
    command: createStandaloneInvocationCommand(context, invocationId),
    context,
  };
}

async function readPosixCommandTokens(command: string): Promise<string[]> {
  const script = [
    'exec "$1" -e',
    "'process.stdout.write(JSON.stringify(process.argv.slice(1)))'",
    '--',
    command,
  ].join(' ');
  const { stdout } = await execFileAsync(
    '/bin/sh',
    ['-c', script, 'limina-query-probe', process.execPath],
    { encoding: 'utf8' },
  );

  return JSON.parse(stdout) as string[];
}

describe('standalone invocation generated commands', () => {
  it('keeps the bounded command context and token order immutable', () => {
    const { command, context } = createSensitiveCommand();

    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.subcommandTokens)).toBe(true);
    expect(context.workspaceRoot).toBe('/tmp/work space/專案 & ^ % ! (x)');
    expect(getGeneratedLiminaCommandTokens(command)).toEqual([
      '/opt/node path/bin/node',
      '/opt/limina path/bin/limina.js',
      '--config',
      '/tmp/work space/專案 & | < > ^ % ! (x)/limina\'"config.mjs',
      '--config-loader',
      'tsx',
      '--mode',
      'ci \' " & | < > ^ % ! ( ) \\ tail\\',
      'check',
      '--issues',
      '--invocation',
      invocationId,
    ]);
    const windowsTokens = [
      '/opt/node path/bin/node',
      '/opt/limina path/bin/limina.js',
      '--config',
      '/tmp/work space/專案 & | < > ^ % ! (x)/limina\'"config.mjs',
      '--config-loader',
      'tsx',
      '--mode',
      'ci \' " & | < > ^ % ! ( ) \\ tail\\',
      'check',
      '--issues',
      '--invocation',
      invocationId,
    ];
    expect(getGeneratedLiminaCommandTokens(command)).toEqual(windowsTokens);
    expect(getGeneratedLiminaCommandTokens(command)).toEqual(windowsTokens);
  });
});

describe('standalone invocation PowerShell transport', () => {
  it.each([
    { appendedArgs: [] },
    { appendedArgs: ['--format', 'json'] },
    { appendedArgs: ['--file', "a 'quoted' file.ts"] },
  ])(
    'round-trips sensitive argv and appended arguments $appendedArgs through the PowerShell transport',
    async ({ appendedArgs }) => {
      const { context } = createSensitiveCommand();
      const expectedArgs = [
        '--config',
        context.configPath,
        '--mode',
        context.mode,
      ];
      const childScript =
        'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
      const transportTokens = createPowerShellNodeTransportTokens(
        process.execPath,
        ['-e', childScript, '--', ...expectedArgs],
      );
      const [executable, ...args] = transportTokens;

      expect(transportTokens[2]).not.toMatch(/["\\]/u);
      const { stdout } = await execFileAsync(
        executable,
        [...args, ...appendedArgs],
        {
          encoding: 'utf8',
        },
      );
      expect(JSON.parse(stdout)).toEqual([...expectedArgs, ...appendedArgs]);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'round-trips the absolute Node executable, CLI and sensitive POSIX arguments',
    async () => {
      const { command } = createSensitiveCommand();
      const rendered = renderGeneratedLiminaCommand(command, 'posix');

      expect(await readPosixCommandTokens(rendered)).toEqual(
        getGeneratedLiminaCommandTokens(command),
      );
    },
  );

  it.runIf(process.platform !== 'win32')(
    'preserves empty arguments and shell metacharacters without evaluating them',
    async () => {
      const context = createGlobalQueryCommandContext({
        cliEntryPath: '/tmp/workspace/node_modules/limina/bin/limina.js',
        configLoader: 'native',
        configPath: '/tmp/workspace/limina.config.mjs',
        mode: '',
        nodeExecutablePath: '/usr/bin/node',
        workspaceRoot: '/tmp/workspace',
      });
      for (const mode of [
        '',
        '$(printf unintended-substitution)',
        '`printf unintended-substitution`',
        '$LIMINA_QUERY_PROBE; & | < > # * ? [x]',
        'single\' double" backslash\\ tail\\',
        "single'quote!",
        "!single'quote",
        '\'!!\' \\! "!"',
        '專案 😀\tline1\nline2\rline3',
      ]) {
        const command = createStandaloneInvocationCommand(
          createGlobalQueryCommandContext({ ...context, mode }),
          invocationId,
        );
        expect(
          await readPosixCommandTokens(
            renderGeneratedLiminaCommand(command, 'posix'),
          ),
        ).toEqual(getGeneratedLiminaCommandTokens(command));
      }
    },
  );
});

describe('standalone invocation platform variants', () => {
  it('keeps direct Node invocation when paths contain pnpm', async () => {
    const context = createGlobalQueryCommandContext({
      cliEntryPath:
        '/tmp/pnpm project/node_modules/.pnpm/limina@0.3.1/node_modules/limina/bin/limina.js',
      configLoader: 'native',
      configPath: '/tmp/pnpm project/limina.config.mjs',
      mode: 'pnpm',
      nodeExecutablePath: '/opt/pnpm/node.exe',
      workspaceRoot: '/tmp/pnpm project',
    });
    const command = createStandaloneInvocationCommand(context, invocationId);
    const expectedTokens = [
      context.nodeExecutablePath,
      context.cliEntryPath,
      '--config',
      context.configPath,
      '--config-loader',
      'native',
      '--mode',
      'pnpm',
      'check',
      '--issues',
      '--invocation',
      invocationId,
    ];
    expect(getGeneratedLiminaCommandTokens(command)).toEqual(expectedTokens);

    const powershell = renderGeneratedLiminaCommand(command, 'powershell');
    expect(powershell).toMatch(
      /^Set-Location -LiteralPath '\/tmp\/pnpm project' -ErrorAction Stop; & '\/opt\/pnpm\/node\.exe' '-e' /u,
    );
    const payload = /'([A-Za-z0-9+/=]+)'$/u.exec(powershell)?.[1] ?? '';
    expect(JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))).toEqual(
      expectedTokens.slice(1),
    );

    if (process.platform !== 'win32') {
      expect(
        await readPosixCommandTokens(
          renderGeneratedLiminaCommand(command, 'posix'),
        ),
      ).toEqual(expectedTokens);
    }
  });

  it('selects a POSIX query or a single explicit PowerShell query', () => {
    expect(getGeneratedCommandPresentation('darwin')).toEqual([
      { dialect: 'posix', label: 'Query' },
    ]);
    expect(getGeneratedCommandPresentation('win32')).toEqual([
      { dialect: 'powershell', label: 'PowerShell' },
    ]);
  });

  it('renders PowerShell through the encoded Node argv transport', () => {
    const { command, context } = createSensitiveCommand();
    const powershell = renderGeneratedLiminaCommand(command, 'powershell');

    expect(powershell).toMatch(/^Set-Location -LiteralPath /u);
    expect(powershell).toContain(' -ErrorAction Stop; & ');
    expect(powershell).toContain("'/opt/node path/bin/node'");
    expect(powershell).toContain(" '-e' ");
    expect(powershell).not.toContain(context.mode);
    expect(powershell).not.toContain('$PSNativeCommandArgumentPassing');
    expect(powershell).not.toContain('pnpm');
  });
});
