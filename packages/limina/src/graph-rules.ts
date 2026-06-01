import { builtinModules } from 'node:module';
import path from 'node:path';
import type { ResolvedLiminaConfig } from './config';
import { isDtsProjectConfig } from './graph-context';
import { normalizeAbsolutePath } from './utils/path';
import { getPackageRootSpecifier, type WorkspacePackage } from './workspace';

export interface GraphRuleRef {
  path: string;
  reason: string;
}

export type GraphRuleRefDeny = GraphRuleRef;
export type GraphRuleRefAllow = GraphRuleRef;

export interface GraphRuleDepDeny {
  kind: 'node-builtin' | 'package' | 'package-import';
  matchAllNodeBuiltins: boolean;
  name: string;
  normalizedName: string;
  reason: string;
}

export interface NormalizedGraphRules {
  allowRefsByLabel: Map<string, Map<string, GraphRuleRefAllow>>;
  depsByLabel: Map<string, GraphRuleDepDeny[]>;
  refsByLabel: Map<string, Map<string, GraphRuleRefDeny>>;
}

interface GraphRuleKindSelection {
  deps?: boolean;
  refs?: boolean;
}

const nodeBuiltinNames = new Set(
  builtinModules.flatMap((specifier) => {
    const normalized = specifier.startsWith('node:')
      ? specifier.slice('node:'.length)
      : specifier;

    return [normalized, `node:${normalized}`];
  }),
);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function formatUnknownValue(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }

  return JSON.stringify(value);
}

function addRuleEntryConfigProblem(
  problems: string[],
  details: string[],
): void {
  problems.push(['Invalid graph rule config:', ...details].join('\n'));
}

function isUrlOrDataOrFileSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith('data:') ||
    specifier.startsWith('file:') ||
    specifier.startsWith('http:') ||
    specifier.startsWith('https:')
  );
}

function isRelativeSpecifier(specifier: string): boolean {
  return (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  );
}

function isPackageImportPattern(name: string): boolean {
  return name.startsWith('#');
}

function matchWildcardPattern(pattern: string, value: string): boolean {
  if (pattern === value) {
    return true;
  }

  const wildcardIndex = pattern.indexOf('*');

  if (wildcardIndex === -1) {
    return false;
  }

  const prefix = pattern.slice(0, wildcardIndex);
  const suffix = pattern.slice(wildcardIndex + 1);

  return value.startsWith(prefix) && value.endsWith(suffix);
}

function getNodeBuiltinRuleName(
  name: string,
): Pick<GraphRuleDepDeny, 'matchAllNodeBuiltins' | 'normalizedName'> | null {
  if (name === 'node:*') {
    return {
      matchAllNodeBuiltins: true,
      normalizedName: '*',
    };
  }

  const normalizedName = name.startsWith('node:') ? name.slice(5) : name;

  if (!nodeBuiltinNames.has(normalizedName)) {
    return null;
  }

  return {
    matchAllNodeBuiltins: false,
    normalizedName,
  };
}

function createNormalizedDep(
  name: string,
  reason: string,
): GraphRuleDepDeny | null {
  const nodeBuiltin = getNodeBuiltinRuleName(name);

  if (nodeBuiltin) {
    return {
      kind: 'node-builtin',
      matchAllNodeBuiltins: nodeBuiltin.matchAllNodeBuiltins,
      name,
      normalizedName: nodeBuiltin.normalizedName,
      reason,
    };
  }

  if (isPackageImportPattern(name)) {
    return {
      kind: 'package-import',
      matchAllNodeBuiltins: false,
      name,
      normalizedName: name,
      reason,
    };
  }

  if (
    isRelativeSpecifier(name) ||
    isUrlOrDataOrFileSpecifier(name) ||
    path.isAbsolute(name) ||
    getPackageRootSpecifier(name) !== name
  ) {
    return null;
  }

  return {
    kind: 'package',
    matchAllNodeBuiltins: false,
    name,
    normalizedName: name,
    reason,
  };
}

function getRulesRecord(
  config: ResolvedLiminaConfig,
  problems: string[],
): Record<string, unknown> {
  const rules = config.graph?.rules;

  if (rules === undefined) {
    return {};
  }

  if (!isPlainRecord(rules)) {
    problems.push(
      [
        'Invalid graph rules config:',
        '  field: graph.rules',
        `  value: ${formatUnknownValue(rules)}`,
        '  reason: graph.rules must be an object keyed by Limina labels.',
      ].join('\n'),
    );
    return {};
  }

  return rules;
}

function addNormalizedRuleRef(options: {
  config: ResolvedLiminaConfig;
  entry: unknown;
  index: number;
  label: string;
  problems: string[];
  projectPathSet: Set<string>;
  refsByLabel: Map<string, Map<string, GraphRuleRef>>;
  ruleKind: 'allow' | 'deny';
}): void {
  const field = `graph.rules.${options.label}.${options.ruleKind}.refs[${options.index}]`;

  if (!isPlainRecord(options.entry)) {
    addRuleEntryConfigProblem(options.problems, [
      `  field: ${field}`,
      `  value: ${formatUnknownValue(options.entry)}`,
      `  reason: ${options.ruleKind}.refs entries must be objects with non-empty path and reason fields.`,
    ]);
    return;
  }

  const pathValue = options.entry.path;
  const reasonValue = options.entry.reason;

  if (!isNonEmptyString(pathValue)) {
    addRuleEntryConfigProblem(options.problems, [
      `  field: ${field}.path`,
      `  value: ${formatUnknownValue(pathValue)}`,
      `  reason: ${options.ruleKind}.refs path is required and must be a non-empty string.`,
    ]);
    return;
  }

  if (!isNonEmptyString(reasonValue)) {
    addRuleEntryConfigProblem(options.problems, [
      `  field: ${field}.reason`,
      `  value: ${formatUnknownValue(reasonValue)}`,
      `  reason: ${options.ruleKind}.refs reason is required and must be a non-empty string.`,
    ]);
    return;
  }

  const refPath = normalizeAbsolutePath(
    path.resolve(options.config.rootDir, pathValue),
  );

  if (!options.projectPathSet.has(refPath)) {
    addRuleEntryConfigProblem(options.problems, [
      `  field: ${field}.path`,
      `  path: ${pathValue}`,
      `  reason: ${options.ruleKind}.refs path must point to a project reachable from a checker entry.`,
    ]);
    return;
  }

  if (!isDtsProjectConfig(refPath)) {
    addRuleEntryConfigProblem(options.problems, [
      `  field: ${field}.path`,
      `  path: ${pathValue}`,
      `  reason: ${options.ruleKind}.refs path must point to a tsconfig*.dts.json declaration leaf.`,
    ]);
    return;
  }

  const refs = options.refsByLabel.get(options.label) ?? new Map();

  refs.set(refPath, {
    path: refPath,
    reason: reasonValue.trim(),
  });
  options.refsByLabel.set(options.label, refs);
}

function addNormalizedDep(options: {
  depsByLabel: Map<string, GraphRuleDepDeny[]>;
  entry: unknown;
  index: number;
  label: string;
  problems: string[];
}): void {
  const field = `graph.rules.${options.label}.deny.deps[${options.index}]`;

  if (!isPlainRecord(options.entry)) {
    addRuleEntryConfigProblem(options.problems, [
      `  field: ${field}`,
      `  value: ${formatUnknownValue(options.entry)}`,
      '  reason: deny.deps entries must be objects with non-empty name and reason fields.',
    ]);
    return;
  }

  const nameValue = options.entry.name;
  const reasonValue = options.entry.reason;

  if (!isNonEmptyString(nameValue)) {
    addRuleEntryConfigProblem(options.problems, [
      `  field: ${field}.name`,
      `  value: ${formatUnknownValue(nameValue)}`,
      '  reason: deny.deps name is required and must be a non-empty string.',
    ]);
    return;
  }

  if (!isNonEmptyString(reasonValue)) {
    addRuleEntryConfigProblem(options.problems, [
      `  field: ${field}.reason`,
      `  value: ${formatUnknownValue(reasonValue)}`,
      '  reason: deny.deps reason is required and must be a non-empty string.',
    ]);
    return;
  }

  const name = nameValue.trim();
  const reason = reasonValue.trim();
  const normalizedDep = createNormalizedDep(name, reason);

  if (!normalizedDep) {
    addRuleEntryConfigProblem(options.problems, [
      `  field: ${field}.name`,
      `  name: ${name}`,
      '  reason: deny.deps name must be a package root, a package.json imports specifier such as "#internal/*", or a Node builtin such as "fs", "node:fs", or "node:*".',
    ]);
    return;
  }

  const deps = options.depsByLabel.get(options.label) ?? [];

  deps.push(normalizedDep);
  options.depsByLabel.set(options.label, deps);
}

function shouldNormalizeRuleKind(
  include: GraphRuleKindSelection | undefined,
  kind: keyof GraphRuleKindSelection,
): boolean {
  return include?.[kind] ?? true;
}

export function normalizeGraphRules(options: {
  config: ResolvedLiminaConfig;
  include?: GraphRuleKindSelection;
  packages: WorkspacePackage[];
  problems: string[];
  projectPaths: string[];
}): NormalizedGraphRules {
  const allowRefsByLabel = new Map<string, Map<string, GraphRuleRefAllow>>();
  const depsByLabel = new Map<string, GraphRuleDepDeny[]>();
  const refsByLabel = new Map<string, Map<string, GraphRuleRefDeny>>();
  const projectPathSet = new Set(options.projectPaths);

  for (const [rawLabel, rawRule] of Object.entries(
    getRulesRecord(options.config, options.problems),
  )) {
    const label = rawLabel.trim();

    if (!label) {
      addRuleEntryConfigProblem(options.problems, [
        '  field: graph.rules',
        '  reason: graph.rules keys must be non-empty labels.',
      ]);
      continue;
    }

    if (!isPlainRecord(rawRule)) {
      addRuleEntryConfigProblem(options.problems, [
        `  field: graph.rules.${rawLabel}`,
        `  value: ${formatUnknownValue(rawRule)}`,
        '  reason: each graph rule must be an object.',
      ]);
      continue;
    }

    if (rawRule.deny !== undefined && !isPlainRecord(rawRule.deny)) {
      addRuleEntryConfigProblem(options.problems, [
        `  field: graph.rules.${label}.deny`,
        `  value: ${formatUnknownValue(rawRule.deny)}`,
        '  reason: graph rule deny must be an object.',
      ]);
      continue;
    }

    const deny = isPlainRecord(rawRule.deny) ? rawRule.deny : undefined;
    const denyRefs = deny?.refs;

    if (
      shouldNormalizeRuleKind(options.include, 'refs') &&
      denyRefs !== undefined
    ) {
      if (Array.isArray(denyRefs)) {
        for (const [index, entry] of denyRefs.entries()) {
          addNormalizedRuleRef({
            config: options.config,
            entry,
            index,
            label,
            problems: options.problems,
            projectPathSet,
            refsByLabel,
            ruleKind: 'deny',
          });
        }
      } else {
        addRuleEntryConfigProblem(options.problems, [
          `  field: graph.rules.${label}.deny.refs`,
          `  value: ${formatUnknownValue(denyRefs)}`,
          '  reason: deny.refs must be an array.',
        ]);
      }
    }

    if (
      shouldNormalizeRuleKind(options.include, 'deps') &&
      deny?.workspaceDeps !== undefined
    ) {
      addRuleEntryConfigProblem(options.problems, [
        `  field: graph.rules.${label}.deny.workspaceDeps`,
        `  value: ${formatUnknownValue(deny.workspaceDeps)}`,
        '  reason: deny.workspaceDeps has been removed; use deny.deps.',
      ]);
    }

    if (
      shouldNormalizeRuleKind(options.include, 'deps') &&
      deny?.nodeBuiltins !== undefined
    ) {
      addRuleEntryConfigProblem(options.problems, [
        `  field: graph.rules.${label}.deny.nodeBuiltins`,
        `  value: ${formatUnknownValue(deny.nodeBuiltins)}`,
        '  reason: deny.nodeBuiltins has been removed; use deny.deps.',
      ]);
    }

    const deps = deny?.deps;

    if (
      shouldNormalizeRuleKind(options.include, 'deps') &&
      deps !== undefined
    ) {
      if (Array.isArray(deps)) {
        for (const [index, entry] of deps.entries()) {
          addNormalizedDep({
            depsByLabel,
            entry,
            index,
            label,
            problems: options.problems,
          });
        }
      } else {
        addRuleEntryConfigProblem(options.problems, [
          `  field: graph.rules.${label}.deny.deps`,
          `  value: ${formatUnknownValue(deps)}`,
          '  reason: deny.deps must be an array.',
        ]);
      }
    }

    if (rawRule.allow !== undefined && !isPlainRecord(rawRule.allow)) {
      addRuleEntryConfigProblem(options.problems, [
        `  field: graph.rules.${label}.allow`,
        `  value: ${formatUnknownValue(rawRule.allow)}`,
        '  reason: graph rule allow must be an object.',
      ]);
      continue;
    }

    const allow = isPlainRecord(rawRule.allow) ? rawRule.allow : undefined;
    const allowRefs = allow?.refs;

    if (
      shouldNormalizeRuleKind(options.include, 'refs') &&
      allowRefs !== undefined
    ) {
      if (Array.isArray(allowRefs)) {
        for (const [index, entry] of allowRefs.entries()) {
          addNormalizedRuleRef({
            config: options.config,
            entry,
            index,
            label,
            problems: options.problems,
            projectPathSet,
            refsByLabel: allowRefsByLabel,
            ruleKind: 'allow',
          });
        }
      } else {
        addRuleEntryConfigProblem(options.problems, [
          `  field: graph.rules.${label}.allow.refs`,
          `  value: ${formatUnknownValue(allowRefs)}`,
          '  reason: allow.refs must be an array.',
        ]);
      }
    }
  }

  return {
    allowRefsByLabel,
    depsByLabel,
    refsByLabel,
  };
}

export function isNodeBuiltinSpecifier(specifier: string): boolean {
  return nodeBuiltinNames.has(specifier);
}

type LabelSelection = readonly string[] | string | null;

function getSelectedLabels(labels: LabelSelection): readonly string[] {
  if (!labels) {
    return [];
  }

  return typeof labels === 'string' ? [labels] : labels;
}

function getRefRule<T extends GraphRuleRef>(
  refsByLabel: Map<string, Map<string, T>>,
  labels: LabelSelection,
  targetProjectPath: string,
): T | null {
  for (const label of getSelectedLabels(labels)) {
    const rule = refsByLabel.get(label)?.get(targetProjectPath);

    if (rule) {
      return rule;
    }
  }

  return null;
}

export function getDeniedRefRule(
  rules: NormalizedGraphRules,
  labels: LabelSelection,
  targetProjectPath: string,
): GraphRuleRefDeny | null {
  return getRefRule(rules.refsByLabel, labels, targetProjectPath);
}

export function getAllowedRefRule(
  rules: NormalizedGraphRules,
  labels: LabelSelection,
  targetProjectPath: string,
): GraphRuleRefAllow | null {
  return getRefRule(rules.allowRefsByLabel, labels, targetProjectPath);
}

function getRuleDeps(
  rules: NormalizedGraphRules,
  labels: LabelSelection,
): GraphRuleDepDeny[] {
  return getSelectedLabels(labels).flatMap(
    (label) => rules.depsByLabel.get(label) ?? [],
  );
}

export function getDeniedDepRuleForPackage(
  rules: NormalizedGraphRules,
  labels: LabelSelection,
  packageName: string,
): GraphRuleDepDeny | null {
  return (
    getRuleDeps(rules, labels).find(
      (rule) => rule.kind === 'package' && rule.normalizedName === packageName,
    ) ?? null
  );
}

export function getDeniedDepRuleForSpecifier(
  rules: NormalizedGraphRules,
  labels: LabelSelection,
  specifier: string,
): GraphRuleDepDeny | null {
  const deps = getRuleDeps(rules, labels);
  const packageImportRule = deps.find(
    (rule) =>
      rule.kind === 'package-import' &&
      matchWildcardPattern(rule.normalizedName, specifier),
  );

  if (packageImportRule) {
    return packageImportRule;
  }

  if (isNodeBuiltinSpecifier(specifier)) {
    const normalizedSpecifier = specifier.startsWith('node:')
      ? specifier.slice(5)
      : specifier;
    const nodeRule = deps.find(
      (rule) =>
        rule.kind === 'node-builtin' &&
        (rule.matchAllNodeBuiltins ||
          rule.normalizedName === normalizedSpecifier),
    );

    if (nodeRule) {
      return nodeRule;
    }
  }

  if (
    isRelativeSpecifier(specifier) ||
    isPackageImportPattern(specifier) ||
    isUrlOrDataOrFileSpecifier(specifier) ||
    path.isAbsolute(specifier)
  ) {
    return null;
  }

  return getDeniedDepRuleForPackage(
    rules,
    labels,
    getPackageRootSpecifier(specifier),
  );
}
