import type { LiminaConfig } from 'limina';
import { expect, it } from 'vitest';
import { addStaticConfigExclusions } from '../migration/config-edit';

const additions = [
  {
    kind: 'tsconfig' as const,
    include: ['packages/app/tsconfig.json'],
    reason: 'Unreadable configuration',
  },
];

it.each([
  'export default { /* keep root comment */ };',
  'import { defineConfig as define } from "limina"; export default define({ /* keep root comment */ });',
  'const config = { /* keep root comment */ }; export default config;',
  'const rules = []; const config = {scope: {regions:{exclude:rules}}}; export default config;',
])(
  'preserves module syntax while inserting one exact exclusion into %s',
  (original) => {
    const edited = addStaticConfigExclusions(
      'limina.config.mts',
      original,
      additions,
    );
    expect(edited).toContain('"kind": "tsconfig"');
    expect(edited).toContain('"packages/app/tsconfig.json"');
    expect(edited.slice(0, edited.indexOf('\n'))).toBe(
      original.slice(0, edited.indexOf('\n')),
    );
    const originalSuffix = original.slice(original.lastIndexOf('}'));
    expect(edited.endsWith(originalSuffix)).toBe(true);
  },
);

it.each([
  'export default { scope: { source: { include: ["src/**/*.ts"] } }, pipelines: { types: ["checker:build"] }, concurrency: { tasks: 1 } };',
  'const boundary = { checkers: { tsc: { include: ["tsconfig.json"] } } }; export default { scope: boundary };',
  'export default { scope: { regions: { extendNestedPackageScopes: true } } };',
])(
  'retains existing settings when adding scope exclusions: %s',
  async (original) => {
    const edited = addStaticConfigExclusions(
      'limina.config.mts',
      original,
      additions,
    );
    const before = (
      await import(`data:text/javascript,${encodeURIComponent(original)}`)
    ).default as LiminaConfig;
    const after = (
      await import(`data:text/javascript,${encodeURIComponent(edited)}`)
    ).default as LiminaConfig;
    expect(after).toEqual({
      ...before,
      scope: {
        ...before.scope,
        regions: { ...before.scope?.regions, exclude: additions },
      },
    });
  },
);

it.each([
  'export default () => ({});',
  'export default Promise.resolve({});',
  'const base = {}; export default {...base};',
  'const config = {}; (config.scope ??= {}).regions = {}; export default config;',
])(
  'preserves unsupported module rather than serializing its evaluated value: %s',
  (original) => {
    expect(() =>
      addStaticConfigExclusions('limina.config.mts', original, additions),
    ).toThrow('Cannot persist exact tsconfig exclusions');
  },
);
