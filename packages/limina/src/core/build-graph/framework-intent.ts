import type { ResolvedLiminaConfig } from '#config/runner';
import { readJsonConfig } from '#core/tsconfig/actions';
import { compareCodeUnits } from '#utils/collections';
import { toRelativePath } from '#utils/path';
import { isPlainRecord } from '#utils/values';
import { parseTypeScriptCommandLine } from '../../checker/project-base';
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

export function inspectFrameworkIntent(options: {
  config: ResolvedLiminaConfig;
  configObject: Record<string, unknown>;
  configPath: string;
}): FrameworkIntentInspection {
  try {
    const { configClosure } = parseTypeScriptCommandLine({
      parseOptions: {
        allowNoInputDiagnostics: true,
        configPath: options.configPath,
        projectRootDir: options.config.rootDir,
      },
    });
    const hints = configClosure.flatMap(({ filePath }) =>
      collectOwnFrameworkIntentHints({
        configObject: readJsonConfig(options.config, filePath),
        configPath: filePath,
      }),
    );
    return {
      intentHints: hints.sort((left, right) =>
        compareCodeUnits(
          `${left.configPath}\0${left.family}\0${left.kind}\0${left.value}`,
          `${right.configPath}\0${right.family}\0${right.kind}\0${right.value}`,
        ),
      ),
      problems: [],
    };
  } catch (error) {
    return {
      intentHints: [],
      problems: [
        [
          'Unavailable auto checker extends config:',
          `  config: ${toRelativePath(options.config.rootDir, options.configPath)}`,
          `  reason: ${error instanceof Error ? error.message : String(error)}`,
          '  fix: generate or install the extended config and correct its diagnostics, then rerun `limina graph prepare`.',
        ].join('\n'),
      ],
    };
  }
}
