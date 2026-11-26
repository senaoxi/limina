import { compareCodeUnits } from '#utils/collections';
import { isPlainRecord } from '#utils/values';
import type { FrameworkIntentHint } from './source-capabilities';

function own(config: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(config, key) ? config[key] : undefined;
}

function addExtendsHint(options: {
  configPath: string;
  extendsValue: string;
  hints: FrameworkIntentHint[];
}): void {
  if (
    /^astro\/tsconfigs\/(?:base|strict|strictest)(?:\.json)?$/u.test(
      options.extendsValue,
    )
  ) {
    options.hints.push({
      configPath: options.configPath,
      family: 'astro',
      kind: 'astro-preset',
      value: options.extendsValue,
    });
  }
  if (
    /(?:^|[\\/])\.svelte-kit[\\/]tsconfig(?:\.json)?$/u.test(
      options.extendsValue,
    )
  ) {
    options.hints.push({
      configPath: options.configPath,
      family: 'svelte',
      kind: 'svelte-kit-extends',
      value: options.extendsValue,
    });
  }
}

function isAstroType(value: unknown): value is string {
  return value === 'astro/client' || value === 'astro/env';
}

function addAstroTypeHints(options: {
  configPath: string;
  hints: FrameworkIntentHint[];
  types: unknown;
}): void {
  const values = Array.isArray(options.types)
    ? options.types.filter(isAstroType)
    : [];
  for (const value of values) {
    options.hints.push({
      configPath: options.configPath,
      family: 'astro',
      kind: 'astro-types',
      value,
    });
  }
}

function isAstroPlugin(value: unknown): value is { name: string } {
  return isPlainRecord(value) && own(value, 'name') === '@astrojs/ts-plugin';
}

function addAstroPluginHints(options: {
  configPath: string;
  hints: FrameworkIntentHint[];
  plugins: unknown;
}): void {
  const values = Array.isArray(options.plugins)
    ? options.plugins.filter(isAstroPlugin)
    : [];
  for (const plugin of values) {
    options.hints.push({
      configPath: options.configPath,
      family: 'astro',
      kind: 'astro-plugin',
      value: plugin.name,
    });
  }
}

function addCompilerOptionsHints(options: {
  configObject: Record<string, unknown>;
  configPath: string;
  hints: FrameworkIntentHint[];
}): void {
  const compilerOptions = own(options.configObject, 'compilerOptions');
  if (!isPlainRecord(compilerOptions)) return;
  addAstroTypeHints({ ...options, types: own(compilerOptions, 'types') });
  addAstroPluginHints({ ...options, plugins: own(compilerOptions, 'plugins') });
}

function getStringValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function getSelectorFamily(selector: string): {
  family: 'astro' | 'svelte' | 'vue';
  kind: FrameworkIntentHint['kind'];
} | null {
  const identities = [
    { family: 'astro', kind: 'astro-selector', marker: '.astro' },
    { family: 'svelte', kind: 'svelte-selector', marker: '.svelte' },
    { family: 'vue', kind: 'vue-selector', marker: '.vue' },
  ] as const;
  return identities.find(({ marker }) => selector.endsWith(marker)) ?? null;
}

function addSelectorHints(options: {
  configObject: Record<string, unknown>;
  configPath: string;
  hints: FrameworkIntentHint[];
}): void {
  const selectors = [
    ...getStringValues(own(options.configObject, 'files')),
    ...getStringValues(own(options.configObject, 'include')),
  ];
  for (const selector of selectors) {
    const identity = getSelectorFamily(selector);
    if (identity === null) continue;
    options.hints.push({
      configPath: options.configPath,
      family: identity.family,
      kind: identity.kind,
      value: selector,
    });
  }
}

export function inspectFrameworkIntent(options: {
  configObject: Record<string, unknown>;
  configPath: string;
}): FrameworkIntentHint[] {
  const { configObject, configPath } = options;
  const hints: FrameworkIntentHint[] = [];
  addCompilerOptionsHints({ ...options, hints });
  addSelectorHints({ ...options, hints });
  const extendsValue = own(configObject, 'extends');
  const declaredPresets =
    typeof extendsValue === 'string'
      ? [extendsValue]
      : getStringValues(extendsValue);
  for (const value of declaredPresets) {
    addExtendsHint({ configPath, extendsValue: value, hints });
  }
  if (isPlainRecord(own(configObject, 'vueCompilerOptions')))
    hints.push({
      configPath,
      family: 'vue',
      kind: 'vue-compiler-options',
      value: 'vueCompilerOptions',
    });
  return hints.sort((left, right) =>
    compareCodeUnits(
      `${left.family}\0${left.kind}\0${left.value}\0${left.configPath}`,
      `${right.family}\0${right.kind}\0${right.value}\0${right.configPath}`,
    ),
  );
}
