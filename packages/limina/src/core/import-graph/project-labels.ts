import type { ResolvedLiminaConfig } from '#config/runner';
import { isDtsConfigPath, readJsonConfig } from '#core/tsconfig/actions';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import { formatUnknownValue, isPlainRecord } from '#utils/values';
import type {
  ProjectGraphLabelDiagnostic,
  ProjectGraphRuleInfo,
} from './project-types';

function createEmptyRuleInfo(): ProjectGraphRuleInfo {
  return {
    labelDiagnostic: null,
    labels: [],
    labelProblem: null,
  };
}

function createDiagnosticInfo(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  field: string;
  reason: string;
  title: string;
  value: unknown;
}): ProjectGraphRuleInfo {
  const detailLines = [
    `${options.title}:`,
    `  project: ${toRelativePath(options.config.rootDir, options.configPath)}`,
    `  field: ${options.field}`,
    `  value: ${formatUnknownValue(options.value)}`,
    `  reason: ${options.reason}`,
  ];
  const labelDiagnostic: ProjectGraphLabelDiagnostic = {
    detailLines,
    field: options.field,
    projectPath: options.configPath,
    reason: options.reason,
    title: options.title,
    value: options.value,
  };
  return {
    labelDiagnostic,
    labels: [],
    labelProblem: detailLines.join('\n'),
  };
}

function readProjectConfigObject(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  virtualFiles: ReadonlyMap<string, string> | undefined;
}): Record<string, unknown> {
  const virtualContent = options.virtualFiles?.get(
    normalizeAbsolutePath(options.configPath),
  );

  if (virtualContent !== undefined) {
    return JSON.parse(virtualContent) as Record<string, unknown>;
  }

  return readJsonConfig(options.config, options.configPath);
}

function parseGraphRuleLabel(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  index: number;
  value: unknown;
}): ProjectGraphRuleInfo | string {
  if (typeof options.value === 'string' && options.value.trim().length > 0) {
    return options.value.trim();
  }

  const field = `liminaOptions.graphRules[${options.index}]`;
  return createDiagnosticInfo({
    config: options.config,
    configPath: options.configPath,
    field,
    reason: 'graph rule labels must be non-empty strings.',
    title: 'Invalid Limina graph rule label',
    value: options.value,
  });
}

function collectGraphRuleLabels(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  graphRules: readonly unknown[];
}): ProjectGraphRuleInfo | string[] {
  const labels = new Set<string>();

  for (const [index, value] of options.graphRules.entries()) {
    const parsed = parseGraphRuleLabel({
      config: options.config,
      configPath: options.configPath,
      index,
      value,
    });

    if (typeof parsed !== 'string') {
      return parsed;
    }

    labels.add(parsed);
  }

  return [...labels];
}

function parseGraphRules(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  graphRules: unknown;
}): ProjectGraphRuleInfo {
  if (!Array.isArray(options.graphRules)) {
    return createDiagnosticInfo({
      config: options.config,
      configPath: options.configPath,
      field: 'liminaOptions.graphRules',
      reason:
        'liminaOptions.graphRules must be an array of non-empty string labels.',
      title: 'Invalid Limina graph rules',
      value: options.graphRules,
    });
  }

  const labels = collectGraphRuleLabels({
    config: options.config,
    configPath: options.configPath,
    graphRules: options.graphRules,
  });

  if (!Array.isArray(labels)) {
    return labels;
  }

  return { labelDiagnostic: null, labels, labelProblem: null };
}

function parseLiminaOptions(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  value: unknown;
}): ProjectGraphRuleInfo {
  if (!isPlainRecord(options.value)) {
    return createDiagnosticInfo({
      config: options.config,
      configPath: options.configPath,
      field: 'liminaOptions',
      reason:
        'liminaOptions must be an object with an optional graphRules array.',
      title: 'Invalid Limina graph options',
      value: options.value,
    });
  }

  if (options.value.graphRules === undefined) {
    return createEmptyRuleInfo();
  }

  return parseGraphRules({
    config: options.config,
    configPath: options.configPath,
    graphRules: options.value.graphRules,
  });
}

export function readProjectGraphRules(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  virtualFiles?: ReadonlyMap<string, string>;
}): ProjectGraphRuleInfo {
  if (!isDtsConfigPath(options.configPath)) {
    return createEmptyRuleInfo();
  }

  const configObject = readProjectConfigObject({
    config: options.config,
    configPath: options.configPath,
    virtualFiles: options.virtualFiles,
  });

  if (!Object.hasOwn(configObject, 'liminaOptions')) {
    return createEmptyRuleInfo();
  }

  return parseLiminaOptions({
    config: options.config,
    configPath: options.configPath,
    value: configObject.liminaOptions,
  });
}

export function formatProjectLabels(labels: readonly string[]): string {
  return labels.length === 0 ? '(none)' : labels.join(', ');
}
