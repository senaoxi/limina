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
  if (!deniedPath.endsWith('.dts.json')) {
    return deniedPath;
  }
  return normalizeAbsolutePath(deniedPath.replace(/\.dts\.json$/u, '.json'));
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

function labelDeniesReference(options: {
  config: ResolvedLiminaConfig;
  label: string;
  rules: GraphRules;
  targetSourceConfigPath: string;
}): boolean {
  const references = getDeniedReferences(options.rules, options.label);
  if (!references) {
    return false;
  }
  return references.some(
    (reference) =>
      normalizeDeniedSourcePath(options.config, reference) ===
      options.targetSourceConfigPath,
  );
}

export function isDeniedGeneratedReference(options: {
  config: ResolvedLiminaConfig;
  project: SourceProject;
  targetSourceConfigPath: string;
}): boolean {
  const rules = options.config.graph?.rules;
  if (!rules) {
    return false;
  }
  return options.project.graphRules.some((label) =>
    labelDeniesReference({ ...options, label, rules }),
  );
}
