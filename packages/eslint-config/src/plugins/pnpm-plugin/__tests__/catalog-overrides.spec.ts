import { ESLint } from 'eslint';
import nativePnpmPlugin from 'eslint-plugin-pnpm';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as yamlParser from 'yaml-eslint-parser';
import { pnpmPlugin } from '../index.js';

describe('catalog use in qualified overrides', () => {
  it.each([
    ['tar', '@vercel/fun>tar'],
    ['@scope/leaf', '@scope/parent@1>@scope/leaf@2'],
  ])(
    'counts %s while retaining genuinely unused reports',
    async (name, selector) => {
      const directory = await mkdtemp(path.join(tmpdir(), 'limina-catalog-'));
      const file = path.join(directory, 'pnpm-workspace.yaml');
      const text = `packages: []\ncatalogs:\n  patches:\n    '${name}': 2.0.0\n    unused: 1.0.0\noverrides:\n  '${selector}': catalog:patches\n`;
      await writeFile(
        path.join(directory, 'package.json'),
        '{"private":true}\n',
      );
      await writeFile(file, text);
      const lint = async (plugin: ESLint.Plugin) => {
        const eslint = new ESLint({
          cwd: directory,
          overrideConfigFile: true,
          overrideConfig: [
            {
              files: ['pnpm-workspace.yaml'],
              languageOptions: { parser: yamlParser },
              plugins: { pnpm: plugin },
              rules: { 'pnpm/yaml-no-unused-catalog-item': 'error' },
            },
          ],
        });
        const [result] = await eslint.lintText(text, { filePath: file });
        return result.messages;
      };
      try {
        const before = await lint(nativePnpmPlugin);
        expect(before).toHaveLength(2);
        const after = await lint(pnpmPlugin);
        expect(after).toHaveLength(1);
        expect(after[0].message).toContain('unused:patches');
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
