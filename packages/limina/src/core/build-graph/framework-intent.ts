import type { ResolvedLiminaConfig } from '#config/runner';
import { readJsonConfig } from '#core/tsconfig/actions';
import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import { isPlainRecord } from '#utils/values';
import { existsSync } from 'node:fs';
import { normalizeExtendsConfigPath } from './generated/compiler-target';
import type {
  FrameworkIntentHint,
  FrameworkIntentInspection,
} from './source-capabilities';

function getExtendsValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function addExtendsHint(options: {
  configPath: string;
  extendsValue: string;
  hints: FrameworkIntentHint[];
}): void {
  if (options.extendsValue.includes('astro/tsconfigs/')) {
    options.hints.push({
      configPath: options.configPath,
      family: 'astro',
      kind: 'astro-preset',
      value: options.extendsValue,
    });
  }
  if (options.extendsValue.includes('.svelte-kit/tsconfig')) {
    options.hints.push({
      configPath: options.configPath,
      family: 'svelte',
      kind: 'svelte-kit-extends',
      value: options.extendsValue,
    });
  }
}

function isAstroType(value: unknown): value is string {
  return typeof value === 'string' && value.includes('astro');
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
  return isPlainRecord(value) && value.name === '@astrojs/ts-plugin';
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
  const compilerOptions = options.configObject.compilerOptions;
  if (!isPlainRecord(compilerOptions)) return;
  addAstroTypeHints({ ...options, types: compilerOptions.types });
  addAstroPluginHints({ ...options, plugins: compilerOptions.plugins });
}

function getSelectorValues(value: unknown): string[] {
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
  return identities.find(({ marker }) => selector.includes(marker)) ?? null;
}

function addSelectorHints(options: {
  configObject: Record<string, unknown>;
  configPath: string;
  hints: FrameworkIntentHint[];
}): void {
  const selectors = [
    ...getSelectorValues(options.configObject.files),
    ...getSelectorValues(options.configObject.include),
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

function collectOwnFrameworkIntentHints(options: {
  configObject: Record<string, unknown>;
  configPath: string;
}): FrameworkIntentHint[] {
  const hints: FrameworkIntentHint[] = [];
  if (isPlainRecord(options.configObject.vueCompilerOptions)) {
    hints.push({
      configPath: options.configPath,
      family: 'vue',
      kind: 'vue-compiler-options',
      value: 'vueCompilerOptions',
    });
  }
  addCompilerOptionsHints({ ...options, hints });
  addSelectorHints({ ...options, hints });
  for (const extendsValue of getExtendsValues(options.configObject.extends)) {
    addExtendsHint({
      configPath: options.configPath,
      extendsValue,
      hints,
    });
  }
  return hints;
}

function createMissingExtendsProblem(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  extendsValue: string;
  resolvedPath: string | null;
}): string {
  const resolvedLine = options.resolvedPath
    ? `  resolved config: ${toRelativePath(options.config.rootDir, options.resolvedPath)}`
    : '  resolved config: (unresolved)';
  return [
    'Unavailable auto checker extends config:',
    `  config: ${toRelativePath(options.config.rootDir, options.configPath)}`,
    `  extends: ${options.extendsValue}`,
    resolvedLine,
    '  reason: auto capability discovery cannot determine the effective source files while an extended config is unavailable.',
    '  fix: generate or install the extended config before running Limina, then rerun `limina graph prepare`.',
  ].join('\n');
}

function inspectFrameworkIntentConfig(options: {
  config: ResolvedLiminaConfig;
  configObject: Record<string, unknown>;
  configPath: string;
  hints: FrameworkIntentHint[];
  problems: string[];
  seen: Set<string>;
}): void {
  const configPath = normalizeAbsolutePath(options.configPath);
  if (options.seen.has(configPath)) return;
  options.seen.add(configPath);
  options.hints.push(
    ...collectOwnFrameworkIntentHints({
      configObject: options.configObject,
      configPath,
    }),
  );
  for (const extendsValue of getExtendsValues(options.configObject.extends)) {
    inspectExtendedFrameworkIntent({
      ...options,
      configPath,
      extendsValue,
    });
  }
}

function inspectExtendedFrameworkIntent(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  extendsValue: string;
  hints: FrameworkIntentHint[];
  problems: string[];
  seen: Set<string>;
}): void {
  const resolvedPath = normalizeExtendsConfigPath(
    options.configPath,
    options.extendsValue,
  );
  if (resolvedPath === null || !existsSync(resolvedPath)) {
    options.problems.push(
      createMissingExtendsProblem({ ...options, resolvedPath }),
    );
    return;
  }
  inspectFrameworkIntentConfig({
    ...options,
    configObject: readJsonConfig(options.config, resolvedPath),
    configPath: resolvedPath,
  });
}

export function inspectFrameworkIntent(options: {
  config: ResolvedLiminaConfig;
  configObject: Record<string, unknown>;
  configPath: string;
}): FrameworkIntentInspection {
  const hints: FrameworkIntentHint[] = [];
  const problems: string[] = [];
  inspectFrameworkIntentConfig({
    ...options,
    hints,
    problems,
    seen: new Set(),
  });
  return {
    intentHints: hints.sort((left, right) =>
      compareCodeUnits(
        `${left.configPath}\0${left.family}\0${left.kind}\0${left.value}`,
        `${right.configPath}\0${right.family}\0${right.kind}\0${right.value}`,
      ),
    ),
    problems,
  };
}
