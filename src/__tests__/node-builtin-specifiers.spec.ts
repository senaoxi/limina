import { isBuiltin } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  createNormalizedDep,
  isNodeBuiltinSpecifier,
} from '../graph-check/dependency-rules';
import { validatePublishedSpecifier } from '../package-check/published-boundary-specifier';

describe('Node builtin specifiers', () => {
  it('recognizes prefix-only builtins without inventing bare aliases', () => {
    expect(isBuiltin('node:test')).toBe(true);
    expect(isBuiltin('test')).toBe(false);
    expect(isNodeBuiltinSpecifier('node:test')).toBe(true);
    expect(isNodeBuiltinSpecifier('test')).toBe(false);
    expect(isNodeBuiltinSpecifier('node:fs')).toBe(true);
    expect(isNodeBuiltinSpecifier('fs')).toBe(true);

    expect(createNormalizedDep('node:test', 'test rule')).toMatchObject({
      kind: 'node-builtin',
      normalizedName: 'test',
    });
    expect(createNormalizedDep('test', 'test rule')).toMatchObject({
      kind: 'package',
      normalizedName: 'test',
    });
  });

  it('uses the same builtin identity at the published package boundary', () => {
    const options = {
      allowedExternalPackages: new Set<string>(),
      importsField: undefined,
      outDir: '/unused',
      packageName: '@example/pkg',
      selfSpecifiers: { exact: new Set<string>(), patterns: [] },
    };

    expect(
      validatePublishedSpecifier({
        ...options,
        environment: 'node',
        specifier: 'node:test',
      }),
    ).toBeNull();
    expect(
      validatePublishedSpecifier({
        ...options,
        environment: 'browser',
        specifier: 'node:test',
      }),
    ).toBe('browser/runtime output must not import Node builtin "node:test"');
    expect(
      validatePublishedSpecifier({
        ...options,
        environment: 'node',
        specifier: 'test',
      }),
    ).toContain('not listed in dependencies');
  });
});
