import type { ResolvedLiminaConfig } from '#config/runner';
import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import type { SourceProject } from './types';

type GraphRules = NonNullable<
  NonNullable<ResolvedLiminaConfig['graph']>['rules']
>;
type DeniedReference = NonNullable<
  NonNullable<NonNullable<GraphRules[string]>['deny']>['refs']
>[number];

function normalizeDeniedSourcePath(
  config: ResolvedLiminaConfig,
  reference: DeniedReference,
): string {
  const deniedPath = normalizeAbsolutePath(
    path.resolve(config.rootDir, reference.path),
  );
  return deniedPath.endsWith('.dts.json')
    ? normalizeAbsolutePath(deniedPath.replace(/\.dts\.json$/u, '.json'))
    : deniedPath;
}

function getDeniedReferences(
  rules: GraphRules,
  label: string,
): DeniedReference[] | undefined {
  const rule = rules[label];
  if (!rule) {
    return undefined;
  }
  const deny = rule.deny;
  return deny ? deny.refs : undefined;
}

function isLabelDeniesReference(options: {
  config: ResolvedLiminaConfig;
  label: string;
  rules: GraphRules;
  targetSourceConfigPath: string;
}): boolean {
  const references = getDeniedReferences(options.rules, options.label);
  return (
    references !== undefined &&
    references.some(
      (reference) =>
        normalizeDeniedSourcePath(options.config, reference) ===
        options.targetSourceConfigPath,
    )
  );
}

export function isDeniedGeneratedReference(options: {
  config: ResolvedLiminaConfig;
  project: SourceProject;
  targetSourceConfigPath: string;
}): boolean {
  return isDeniedGeneratedReferenceForConfig({
    config: options.config,
    graphRules: options.project.graphRules,
    targetSourceConfigPath: options.targetSourceConfigPath,
  });
}

export function isDeniedGeneratedReferenceForConfig(options: {
  config: ResolvedLiminaConfig;
  graphRules: readonly string[];
  targetSourceConfigPath: string;
}): boolean {
  const rules = options.config.graph?.rules;
  return (
    rules !== undefined &&
    options.graphRules.some((label) =>
      isLabelDeniesReference({ ...options, label, rules }),
    )
  );
}
