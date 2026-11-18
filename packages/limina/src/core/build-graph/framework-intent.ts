import type { ResolvedLiminaInputs } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { toRelativePath } from '#utils/path';
import { isPlainRecord } from '#utils/values';
import ts from 'typescript';
import { z } from 'zod';
import {
  createProjectParseHost,
  parseTypeScriptCommandLine,
} from '../../checker/project-base';
import {
  resolveConfigProjection,
  type ResolvedConfigProjection,
} from '../../checker/resolved-config';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import type {
  FrameworkIntentHint,
  FrameworkIntentInspection,
} from './source-capabilities';

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

interface FrameworkInspectionInput {
  config: ResolvedLiminaInputs;
  configObject: Record<string, unknown>;
  configPath: string;
}

const intentHintsSchema = z.array(
  z.strictObject({
    configPath: z.string(),
    family: z.enum(['astro', 'svelte', 'vue']),
    kind: z.enum([
      'astro-preset',
      'astro-types',
      'astro-plugin',
      'astro-selector',
      'svelte-kit-extends',
      'svelte-selector',
      'vue-compiler-options',
      'vue-selector',
    ]),
    value: z.string(),
  }),
);

const intentSchema = z.strictObject({
  intentHints: intentHintsSchema,
  configFiles: z.array(z.string()).min(1),
});

export function inspectFrameworkIntent(
  options: FrameworkInspectionInput,
): FrameworkIntentInspection {
  const parseOptions = {
    allowNoInputDiagnostics: true,
    configPath: options.configPath,
    projectRootDir: options.config.rootDir,
    virtualFiles: options.config.virtualFiles,
  };
  try {
    const { intentHints } = resolveConfigProjection(
      'ownership-intent',
      parseOptions,
      undefined,
      () => {
        const resolved = parseTypeScriptCommandLine({ parseOptions });
        return {
          intentHints: effectiveHints(options, resolved),
          configFiles: resolved.configClosure.map(({ filePath }) => filePath),
        };
      },
      {
        requiredFiles: (value) => value.configFiles,
        encode: (value) => JSON.stringify(value),
        decode: (payload) => intentSchema.safeParse(JSON.parse(payload)).data,
      },
    );
    return { intentHints, problems: [] };
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

function effectiveHints(
  options: FrameworkInspectionInput,
  resolved: ResolvedConfigProjection,
): FrameworkIntentHint[] {
  const { parsed, vueOptionsPath, extendsDeclarations } = resolved;
  const hints: FrameworkIntentHint[] = [];
  addCompilerOptionsHints({
    configObject: { compilerOptions: parsed.options },
    configPath: options.configPath,
    hints,
  });
  addSelectorHints({
    configObject: parsed.raw,
    configPath: options.configPath,
    hints,
  });
  const presetHints: FrameworkIntentHint[] = [];
  for (const { configPath, values } of extendsDeclarations)
    for (const extendsValue of values)
      addExtendsHint({ configPath, extendsValue, hints: presetHints });
  for (const family of ['astro', 'svelte'] as const) {
    const matching = presetHints.filter((hint) => hint.family === family);
    if (
      matching.length > 0 &&
      hasEffectivePresetContribution(options, parsed, matching)
    )
      hints.push(...matching);
  }
  if (vueOptionsPath !== null)
    hints.push({
      configPath: vueOptionsPath,
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

function hasEffectivePresetContribution(
  input: FrameworkInspectionInput,
  parsed: ResolvedConfigProjection['parsed'],
  matching: readonly FrameworkIntentHint[],
): boolean {
  const virtualFiles = new Map(input.config.virtualFiles);
  const host = createProjectParseHost(virtualFiles);
  // Remove the declared preset edges, then let TypeScript resolve the remaining
  // configuration. A package may export a preset from any physical filename.
  const configs = new Set(matching.map((hint) => hint.configPath));
  for (const configPath of configs) {
    const without = new Set(
      matching
        .filter((hint) => hint.configPath === configPath)
        .map((hint) => hint.value),
    );
    const { config, error } = ts.readConfigFile(configPath, host.readFile);
    if (error)
      throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
    const retained = (
      Array.isArray(config.extends) ? config.extends : [config.extends]
    ).filter((value: string) => !without.has(value));
    if (retained.length > 0) config.extends = retained;
    else delete config.extends;
    virtualFiles.set(configPath, JSON.stringify(config));
  }
  const withoutPreset = ts.getParsedCommandLineOfConfigFile(
    input.configPath,
    {},
    {
      ...host,
      // Only effective selectors and options enter this comparison.
      readDirectory: () => [],
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
  const signature = (command: Pick<ts.ParsedCommandLine, 'options' | 'raw'>) =>
    JSON.stringify([
      Object.entries(effectiveCompilerOptions(command.options)).sort(
        ([left], [right]) => compareCodeUnits(left, right),
      ),
      command.raw?.files,
      command.raw?.include,
      command.raw?.exclude,
    ]);
  return signature(parsed) !== signature(withoutPreset);
}
