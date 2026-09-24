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
  it('round-trips sensitive argv through the encoded PowerShell transport', async () => {
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
    const { stdout } = await execFileAsync(executable, args, {
      encoding: 'utf8',
    });
    expect(JSON.parse(stdout)).toEqual(expectedArgs);
  });

  it.runIf(process.platform !== 'win32')(
    'renders the absolute Node executable and CLI with POSIX quoting',
    () => {
      const { command } = createSensitiveCommand();
      const rendered = renderGeneratedLiminaCommand(command, 'posix');

      expect(rendered).toContain(
        "'/opt/node path/bin/node' '/opt/limina path/bin/limina.js'",
      );
      expect(rendered).toContain("'--config-loader' 'tsx'");
      expect(rendered).toContain(
        "'--invocation' '123e4567-e89b-42d3-a456-426614174000'",
      );
      expect(rendered).toContain("'/opt/limina path/bin/limina.js'");
      expect(rendered).not.toMatch(/^'pnpm'/u);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'preserves an empty bounded argument',
    () => {
      const context = createGlobalQueryCommandContext({
        cliEntryPath: '/tmp/workspace/node_modules/limina/bin/limina.js',
        configLoader: 'native',
        configPath: '/tmp/workspace/limina.config.mjs',
        mode: '',
        nodeExecutablePath: '/usr/bin/node',
        workspaceRoot: '/tmp/workspace',
      });
      const rendered = renderGeneratedLiminaCommand(
        createStandaloneInvocationCommand(context, invocationId),
        'posix',
      );

      expect(rendered).toContain("'--mode' ''");
    },
  );
});

describe('standalone invocation platform variants', () => {
  it('keeps direct Node invocation when paths contain pnpm', () => {
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

    if (process.platform === 'win32') {
      expect(renderGeneratedLiminaCommand(command, 'cmd')).toContain(
        `cd /d "/tmp/pnpm project" && "/opt/pnpm/node.exe" "${context.cliEntryPath}" `,
      );
    } else {
      expect(renderGeneratedLiminaCommand(command, 'posix')).toMatch(
        /^'\/opt\/pnpm\/node\.exe' '\/tmp\/pnpm project\/node_modules\/\.pnpm\/limina@0\.3\.1\/node_modules\/limina\/bin\/limina\.js' /u,
      );
    }
  });

  it('selects one POSIX variant and two explicit Windows variants', () => {
    expect(getGeneratedCommandPresentation('darwin')).toEqual([
      { dialect: 'posix', label: 'Query' },
    ]);
    expect(getGeneratedCommandPresentation('win32')).toEqual([
      { dialect: 'powershell', label: 'PowerShell' },
      { dialect: 'cmd', label: 'cmd.exe (/V:OFF)' },
    ]);
    expect(
      getGeneratedCommandPresentation('win32').some(({ label }) =>
        label.includes('/V:ON'),
      ),
    ).toBe(false);
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

  it.runIf(process.platform === 'win32')(
    'renders a separate cmd.exe command on Windows',
    () => {
      const { command } = createSensitiveCommand();
      const powershell = renderGeneratedLiminaCommand(command, 'powershell');
      const cmd = renderGeneratedLiminaCommand(command, 'cmd');

      expect(cmd).toMatch(/^cd \/d /u);
      expect(cmd).toContain(' && ');
      expect(cmd).not.toContain('pnpm');
      expect(powershell).not.toBe(cmd);
    },
  );
});
