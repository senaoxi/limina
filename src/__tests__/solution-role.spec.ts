import { describe, expect, it } from 'vitest';
import {
  isLiminaSolutionConfig,
  isTypeScriptSolutionConfig,
  isUnsupportedNamedSolutionConfig,
} from '../core/tsconfig/actions';

function input(options: {
  configObject?: Record<string, unknown>;
  configPath?: string;
  fileNames?: string[];
}) {
  return {
    configObject: options.configObject ?? { references: [] },
    configPath: options.configPath ?? '/workspace/tsconfig.json',
    fileNames: options.fileNames ?? [],
  };
}

describe('tsconfig solution roles', () => {
  it.each([
    ['files: []', { files: [] }],
    ['include: []', { include: [] }],
    ['inherited empty files', { extends: './tsconfig.solution-base.json' }],
    ['references: []', { references: [] }],
  ])('recognizes %s when the effective file set is empty', (_label, fields) => {
    expect(
      isTypeScriptSolutionConfig(
        input({ configObject: { ...fields, references: [] } }),
      ),
    ).toBe(true);
  });

  it('requires references to be declared directly by the config', () => {
    expect(
      isTypeScriptSolutionConfig(
        input({ configObject: { extends: './tsconfig.base.json' } }),
      ),
    ).toBe(false);
  });

  it.each(['/workspace/src/index.ts', '/workspace/src/App.vue'])(
    'rejects an effective source file (%s)',
    (fileName) => {
      expect(isTypeScriptSolutionConfig(input({ fileNames: [fileName] }))).toBe(
        false,
      );
    },
  );

  it('supports the semantic role only at the default Limina entry path', () => {
    expect(isLiminaSolutionConfig(input({}))).toBe(true);
    expect(
      isLiminaSolutionConfig(
        input({ configPath: '/workspace/tsconfig.solution.json' }),
      ),
    ).toBe(false);
  });

  it('identifies ordinary named solutions for migration diagnostics', () => {
    expect(
      isUnsupportedNamedSolutionConfig({
        ...input({ configPath: '/workspace/tsconfig.solution.json' }),
        rootDir: '/workspace',
      }),
    ).toBe(true);
    expect(
      isUnsupportedNamedSolutionConfig({
        ...input({ configPath: '/workspace/tsconfig.build.json' }),
        rootDir: '/workspace',
      }),
    ).toBe(false);
  });
});
