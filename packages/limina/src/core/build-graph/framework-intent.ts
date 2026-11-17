import type { ResolvedLiminaInputs } from '#config/runner';
import { readJsonConfig } from '#core/tsconfig/actions';
import { compareCodeUnits } from '#utils/collections';
import { toRelativePath } from '#utils/path';
import { isPlainRecord } from '#utils/values';
import ts from 'typescript';
import {
  createProjectParseHost,
  parseTypeScriptCommandLine,
} from '../../checker/project-base';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import type {
  FrameworkIntentHint,
  FrameworkIntentInspection,
} from './source-capabilities';

function getExtendsValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
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
    /(?:^|\/)\.svelte-kit\/tsconfig(?:\.json)?$/u.test(options.extendsValue)
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
  return identities.find(({ marker }) => selector.endsWith(marker)) ?? null;
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

export function inspectFrameworkIntent(options: {
  config: ResolvedLiminaInputs;
  configObject: Record<string, unknown>;
  configPath: string;
}): FrameworkIntentInspection {
  try {
    const { configClosure, parsed } = parseTypeScriptCommandLine({
      parseOptions: {
        allowNoInputDiagnostics: true,
        configPath: options.configPath,
        projectRootDir: options.config.rootDir,
        virtualFiles: options.config.virtualFiles,
      },
    });
    const hints: FrameworkIntentHint[] = [];
    addCompilerOptionsHints({
      configObject: { compilerOptions: parsed.options },
      configPath: options.configPath,
      hints,
    });
    addSelectorHints({
      configObject: parsed.raw as Record<string, unknown>,
      configPath: options.configPath,
      hints,
    });
    const presetHints: FrameworkIntentHint[] = [];
    for (const { filePath } of configClosure) {
      const object = readJsonConfig(options.config, filePath);
      for (const value of getExtendsValues(object.extends))
        addExtendsHint({
          configPath: filePath,
          extendsValue: value,
          hints: presetHints,
        });
    }
    for (const family of ['astro', 'svelte'] as const) {
      const matching = presetHints.filter((hint) => hint.family === family);
      if (
        matching.length > 0 &&
        hasEffectivePresetContribution({
          ...options,
          parsed,
          configClosure,
          family,
        })
      )
        hints.push(...matching);
    }
    const configFile = parsed.options.configFile;
    const ordered: string[] =
      isPlainRecord(configFile) && Array.isArray(configFile.extendedSourceFiles)
        ? configFile.extendedSourceFiles
            .filter((value): value is string => typeof value === 'string')
            .toReversed()
        : [];
    ordered.push(options.configPath);
    let vue: unknown;
    let vueConfigPath = options.configPath;
    for (const filePath of ordered) {
      const object = readJsonConfig(options.config, filePath);
      if (!Object.hasOwn(object, 'vueCompilerOptions')) {
        continue;
      }

      vue = object.vueCompilerOptions;
      vueConfigPath = filePath;
    }
    if (isPlainRecord(vue))
      hints.push({
        configPath: vueConfigPath,
        family: 'vue',
        kind: 'vue-compiler-options',
        value: 'vueCompilerOptions',
      });
    return {
      intentHints: hints.sort((left, right) =>
        compareCodeUnits(
          `${left.family}\0${left.kind}\0${left.value}\0${left.configPath}`,
          `${right.family}\0${right.kind}\0${right.value}\0${right.configPath}`,
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

function hasEffectivePresetContribution(
  input: Parameters<typeof inspectFrameworkIntent>[0] &
    ReturnType<typeof parseTypeScriptCommandLine> & {
      family: 'astro' | 'svelte';
    },
): boolean {
  const entries = input.configClosure.filter(({ filePath }) =>
    input.family === 'astro'
      ? /\/node_modules\/astro\/tsconfigs\/(?:base|strict|strictest)\.json$/u.test(
          filePath,
        )
      : /\/\.svelte-kit\/tsconfig\.json$/u.test(filePath),
  );
  if (entries.length === 0) return false;
  const virtualFiles = new Map(input.config.virtualFiles);
  for (const entry of entries) virtualFiles.set(entry.filePath, '{}');
  // The real closure was already observed. This counterfactual must not
  // publish substituted bytes as another read of the same analysis input.
  const withoutPreset = ts.getParsedCommandLineOfConfigFile(
    input.configPath,
    {},
    {
      ...createProjectParseHost(virtualFiles),
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        );
      },
    },
  );
  if (withoutPreset === undefined)
    throw new Error(
      `Cannot resolve effective preset contributions for ${input.configPath}.`,
    );
  const signature = (parsed: typeof input.parsed) => {
    const options = Object.entries(
      effectiveCompilerOptions(parsed.options),
    ).sort(([left], [right]) => compareCodeUnits(left, right));
    return JSON.stringify([
      options,
      parsed.raw?.files,
      parsed.raw?.include,
      parsed.raw?.exclude,
    ]);
  };
  return signature(input.parsed) !== signature(withoutPreset);
}
