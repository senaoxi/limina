export const unsupportedCheckerNameReason =
  'scope.checkers keys must be one of: auto, tsc, tsgo, vue-tsc, svelte-check, astro.';
export const legacyAutoCheckerConfigReason =
  'scope.checkers.mode was removed; migrate to scope.checkers.auto: { exclude, useTsgo }.';

export const checkerConfigKeys: Set<string> = new Set(['exclude', 'include']);
export const autoCheckerKeys: Set<string> = new Set(['exclude', 'useTsgo']);
export const checkerNames: Set<string> = new Set([
  'tsc',
  'tsgo',
  'vue-tsc',
  'svelte-check',
  'astro',
]);
