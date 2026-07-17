import { describe, expect, it } from 'vitest';
import {
  createGlobalQueryCommandContext,
  createStandaloneInvocationCommand,
  getGeneratedCommandPresentation,
  getGeneratedLiminaCommandTokens,
  renderGeneratedLiminaCommand,
} from '../check-reporting/standalone-invocation-command';

const invocationId = '123e4567-e89b-42d3-a456-426614174000';

function createSensitiveCommand() {
  const context = createGlobalQueryCommandContext({
    configLoader: 'tsx',
    configPath: '/tmp/work space/專案 & | < > ^ % ! (x)/limina\'"config.mjs\\',
    mode: 'ci \' " & | < > ^ % ! ( ) \\ tail\\',
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
      'pnpm',
      '--dir',
      '/tmp/work space/專案 & ^ % ! (x)',
      'exec',
      'limina',
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
  });

  it.runIf(process.platform !== 'win32')(
    'renders a POSIX command with Shescape while keeping pnpm executable',
    () => {
      const { command } = createSensitiveCommand();
      const rendered = renderGeneratedLiminaCommand(command, 'posix');

      expect(rendered).toMatch(/^pnpm '--dir' /u);
      expect(rendered).toContain("'--config-loader' 'tsx'");
      expect(rendered).toContain(
        "'--invocation' '123e4567-e89b-42d3-a456-426614174000'",
      );
      expect(rendered).toContain(`'limina'`);
      expect(rendered).not.toMatch(/^'pnpm'/u);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'preserves an empty bounded argument',
    () => {
      const context = createGlobalQueryCommandContext({
        configLoader: 'native',
        configPath: '/tmp/workspace/limina.config.mjs',
        mode: '',
        workspaceRoot: '/tmp/workspace',
      });
      const rendered = renderGeneratedLiminaCommand(
        createStandaloneInvocationCommand(context, invocationId),
        'posix',
      );

      expect(rendered).toContain("'--mode' ''");
    },
  );

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

  it.runIf(process.platform === 'win32')(
    'renders separate PowerShell and cmd.exe commands on Windows',
    () => {
      const { command } = createSensitiveCommand();
      const powershell = renderGeneratedLiminaCommand(command, 'powershell');
      const cmd = renderGeneratedLiminaCommand(command, 'cmd');

      expect(powershell).toMatch(/^pnpm '--dir' /u);
      expect(cmd).toMatch(/^pnpm "--dir" /u);
      expect(powershell).not.toBe(cmd);
    },
  );
});
