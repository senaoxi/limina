import {
  collectGraphProjectRouteFromRoot,
  validateUserMaintainedLiminaTsconfigMetadata,
} from '#core/tsconfig/actions';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const removedMetadataError = [
  'Invalid Limina tsconfig metadata:',
  '  field: limina',
  '  reason: root-level limina metadata is not part of the Limina 0.2.0 tsconfig contract.',
].join('\n');

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

describe('user-maintained Limina tsconfig metadata', () => {
  it('rejects removed root limina metadata with the unified error', () => {
    expect(() =>
      validateUserMaintainedLiminaTsconfigMetadata({
        configObject: {
          limina: 'runtime',
        },
        configPath: path.join('/workspace', 'tsconfig.json'),
      }),
    ).toThrow(removedMetadataError);
  });

  it('accepts unrelated root extensions', () => {
    expect(() =>
      validateUserMaintainedLiminaTsconfigMetadata({
        configObject: {
          customTool: {
            enabled: true,
          },
        },
        configPath: path.join('/workspace', 'tsconfig.json'),
      }),
    ).not.toThrow();
  });

  it('accepts current user-maintained liminaOptions', () => {
    expect(() =>
      validateUserMaintainedLiminaTsconfigMetadata({
        configObject: {
          liminaOptions: {
            graphRules: ['runtime'],
            outputs: {
              outDir: './dist',
            },
          },
        },
        configPath: path.join('/workspace', 'tsconfig.json'),
      }),
    ).not.toThrow();
  });

  it('does not apply the user metadata contract to generated .limina configs', () => {
    expect(() =>
      validateUserMaintainedLiminaTsconfigMetadata({
        configObject: {
          limina: 'generated-internal',
          liminaOptions: {
            checker: 'typescript',
            generated: true,
            sourceConfig: '../../../../tsconfig.json',
          },
        },
        configPath: path.join(
          '/workspace',
          '.limina',
          'tsconfig',
          'checkers',
          'typescript',
          'projects',
          'tsconfig.dts.json',
        ),
      }),
    ).not.toThrow();
  });

  it('rejects removed metadata on an activated user graph route', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-metadata-'));
    const configPath = path.join(rootDir, 'tsconfig.build.json');

    try {
      await writeJson(configPath, {
        files: [],
        limina: 'runtime',
        references: [],
      });

      expect(() =>
        collectGraphProjectRouteFromRoot({
          rootConfigPath: configPath,
          rootDir,
        }),
      ).toThrow(removedMetadataError);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });
});
