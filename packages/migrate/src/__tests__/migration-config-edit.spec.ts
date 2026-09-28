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
  'const rules = []; const config = {regions:{exclude:rules}}; export default config;',
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
    expect(edited.endsWith(original.slice(original.lastIndexOf('}')))).toBe(
      true,
    );
  },
);

it.each([
  'export default () => ({});',
  'export default Promise.resolve({});',
  'const base = {}; export default {...base};',
  'const config = {}; config.regions = {}; export default config;',
])(
  'preserves unsupported module rather than serializing its evaluated value: %s',
  (original) => {
    expect(() =>
      addStaticConfigExclusions('limina.config.mts', original, additions),
    ).toThrow('Cannot persist exact tsconfig exclusions');
  },
);
