import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import * as yamlParser from 'yaml-eslint-parser';
import general from '../general.js';
import { rootFileConfigs } from '../presets/root.js';

describe('language-specific fixes', () => {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      ...general,
      ...rootFileConfigs,
      {
        files: ['**/*.yaml'],
        languageOptions: { parser: yamlParser },
      },
    ],
    fix: true,
  });

  it('retains shared rule overrides when composing root file settings', async () => {
    const [result] = await eslint.lintText('export const value = null;\n', {
      filePath: 'settings.mjs',
    });

    expect(result?.errorCount).toBe(0);
  });

  it('preserves YAML comments while fixing formatting', async () => {
    const comment =
      '# The dependency requires a newer runtime than the minimum supported by this workspace.';
    const [result] = await eslint.lintText(`${comment}\nvalue:   1\n`, {
      filePath: 'settings.yaml',
    });

    expect(result?.fatalErrorCount).toBe(0);
    expect(result?.errorCount).toBe(0);
    expect(result?.output).toBe(`${comment}\nvalue: 1\n`);
  });

  it('still applies the recommended comment fix to JavaScript', async () => {
    const [result] = await eslint.lintText(
      '/* The dependency requires a newer runtime than the minimum supported by this workspace. */\nexport const value = 1;\n',
      { filePath: 'settings.mjs' },
    );

    expect(result?.fatalErrorCount).toBe(0);
    expect(result?.errorCount).toBe(0);
    expect(result?.output).toBe(
      '/*\nThe dependency requires a newer runtime than the minimum supported by this workspace.\n*/\nexport const value = 1;\n',
    );
  });
});
