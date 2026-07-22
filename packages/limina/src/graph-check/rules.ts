import type { ResolvedLiminaConfig } from '#config/runner';
import { isDtsProjectConfig } from '#core/import-graph/context';
import {
  getPackageRootSpecifier,
  type WorkspacePackage,
} from '#core/workspace/actions';
import {
  isPackageImportSpecifier,
  isRelativeSpecifier,
  isUrlOrDataOrFileSpecifier,
} from '#utils/module-specifier';
import { normalizeAbsolutePath } from '#utils/path';
import {
  formatUnknownValue,
  isNonEmptyString,
  isPlainRecord,
} from '#utils/values';
import { builtinModules } from 'node:module';
import path from 'pathe';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { GraphConfigInvalidFinding, GraphFinding } from './findings';

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

const graphRuleKeys = new Set(['allow', 'deny']);
const graphRuleAllowKeys = new Set(['refs']);
const graphRuleDenyKeys = new Set(['deps', 'refs']);

const nodeBuiltinNames = new Set(
  builtinModules.flatMap((specifier) => {
    const normalized = specifier.startsWith('node:')
      ? specifier.slice('node:'.length)
      : specifier;

    return [normalized, `node:${normalized}`];
  }),
);

function addRuleEntryConfigFinding(
  config: ResolvedLiminaConfig,
  findings: GraphFinding[],
  details: readonly string[],
  reason: string,
): void {
  const lines = ['Invalid graph rule config:', ...details];

  findings.push({
    code: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
    evidence: [
      {
        label: 'graph rule configuration',
        lines: [...details],
      },
    ],
    facts: {
      configPath: config.configPath,
      kind: 'graph-rule',
    },
    filePath: config.configPath,
    locations: [
      {
        filePath: config.configPath,
        label: 'Limina config',
      },
    ],
    presentation: {
      detailLines: lines,
      reason,
      title: 'Invalid graph rule config',
    },
    task: 'graph:check',
  } satisfies GraphConfigInvalidFinding);
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

  if (isPackageImportSpecifier(name)) {
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
  findings: GraphFinding[],
): Record<string, unknown> {
  const rules = config.graph?.rules;

  if (rules === undefined) {
    return {};
  }

  if (!isPlainRecord(rules)) {
    const reason = 'graph.rules must be an object keyed by Limina labels.';
    const lines = [
      'Invalid graph rules config:',
      '  field: graph.rules',
      `  value: ${formatUnknownValue(rules)}`,
      `  reason: ${reason}`,
    ];

    findings.push({
      code: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
      evidence: [
        {
          label: 'field',
          value: 'graph.rules',
        },
        {
          label: 'value',
          value: formatUnknownValue(rules),
        },
      ],
      facts: {
        configPath: config.configPath,
        field: 'graph.rules',
        kind: 'graph-rule',
      },
      filePath: config.configPath,
      locations: [
        {
          filePath: config.configPath,
          label: 'Limina config',
        },
      ],
      presentation: {
        detailLines: lines,
        reason,
        title: 'Invalid graph rules config',
      },
      task: 'graph:check',
    } satisfies GraphConfigInvalidFinding);
    return {};
  }

  return rules;
}

function addNormalizedRuleRef(options: {
  config: ResolvedLiminaConfig;
  entry: unknown;
  index: number;
  label: string;
  findings: GraphFinding[];
  projectPathAliases?: Map<string, string>;
  projectPathSet: Set<string>;
  refsByLabel: Map<string, Map<string, GraphRuleRef>>;
  ruleKind: 'allow' | 'deny';
}): void {
  const field = `graph.rules.${options.label}.${options.ruleKind}.refs[${options.index}]`;

  if (!isPlainRecord(options.entry)) {
    const reason = `${options.ruleKind}.refs entries must be objects with non-empty path and reason fields.`;
    addRuleEntryConfigFinding(
      options.config,
      options.findings,
      [
        `  field: ${field}`,
        `  value: ${formatUnknownValue(options.entry)}`,
        `  reason: ${reason}`,
      ],
      reason,
    );
    return;
  }

  const pathValue = options.entry.path;
  const reasonValue = options.entry.reason;

  if (!isNonEmptyString(pathValue)) {
    const reason = `${options.ruleKind}.refs path is required and must be a non-empty string.`;
    addRuleEntryConfigFinding(
      options.config,
      options.findings,
      [
        `  field: ${field}.path`,
        `  value: ${formatUnknownValue(pathValue)}`,
        `  reason: ${reason}`,
      ],
      reason,
    );
    return;
  }

  if (!isNonEmptyString(reasonValue)) {
    const reason = `${options.ruleKind}.refs reason is required and must be a non-empty string.`;
    addRuleEntryConfigFinding(
      options.config,
      options.findings,
      [
        `  field: ${field}.reason`,
        `  value: ${formatUnknownValue(reasonValue)}`,
        `  reason: ${reason}`,
      ],
      reason,
    );
    return;
  }

  const refPath = normalizeAbsolutePath(
    path.resolve(options.config.rootDir, pathValue),
  );
  const normalizedRefPath = options.projectPathSet.has(refPath)
    ? refPath
    : options.projectPathAliases?.get(refPath);

  if (!normalizedRefPath || !options.projectPathSet.has(normalizedRefPath)) {
    const reason = `${options.ruleKind}.refs path must point to a source tsconfig or generated declaration project reachable from a checker entry.`;
    addRuleEntryConfigFinding(
      options.config,
      options.findings,
      [`  field: ${field}.path`, `  path: ${pathValue}`, `  reason: ${reason}`],
      reason,
    );
    return;
  }

  if (!isDtsProjectConfig(normalizedRefPath)) {
    const reason = `${options.ruleKind}.refs path must point to a tsconfig*.dts.json declaration leaf.`;
    addRuleEntryConfigFinding(
      options.config,
      options.findings,
      [`  field: ${field}.path`, `  path: ${pathValue}`, `  reason: ${reason}`],
      reason,
    );
    return;
  }

  const refs = options.refsByLabel.get(options.label) ?? new Map();

  refs.set(normalizedRefPath, {
    path: normalizedRefPath,
    reason: reasonValue.trim(),
  });
  options.refsByLabel.set(options.label, refs);
}

function addNormalizedDep(options: {
  config: ResolvedLiminaConfig;
  depsByLabel: Map<string, GraphRuleDepDeny[]>;
  entry: unknown;
  index: number;
  label: string;
  findings: GraphFinding[];
}): void {
  const field = `graph.rules.${options.label}.deny.deps[${options.index}]`;

  if (!isPlainRecord(options.entry)) {
    const reason =
      'deny.deps entries must be objects with non-empty name and reason fields.';
    addRuleEntryConfigFinding(
      options.config,
      options.findings,
      [
        `  field: ${field}`,
        `  value: ${formatUnknownValue(options.entry)}`,
        `  reason: ${reason}`,
      ],
      reason,
    );
    return;
  }

  const nameValue = options.entry.name;
  const reasonValue = options.entry.reason;

  if (!isNonEmptyString(nameValue)) {
    const reason = 'deny.deps name is required and must be a non-empty string.';
    addRuleEntryConfigFinding(
      options.config,
      options.findings,
      [
        `  field: ${field}.name`,
        `  value: ${formatUnknownValue(nameValue)}`,
        `  reason: ${reason}`,
      ],
      reason,
    );
    return;
  }

  if (!isNonEmptyString(reasonValue)) {
    const reason =
      'deny.deps reason is required and must be a non-empty string.';
    addRuleEntryConfigFinding(
      options.config,
      options.findings,
      [
        `  field: ${field}.reason`,
        `  value: ${formatUnknownValue(reasonValue)}`,
        `  reason: ${reason}`,
      ],
      reason,
    );
    return;
  }

  const name = nameValue.trim();
  const reason = reasonValue.trim();
  const normalizedDep = createNormalizedDep(name, reason);

  if (!normalizedDep) {
    const problemReason =
      'deny.deps name must be a package root, a package.json imports specifier such as "#internal/*", or a Node builtin such as "fs", "node:fs", or "node:*".';
    addRuleEntryConfigFinding(
      options.config,
      options.findings,
      [
        `  field: ${field}.name`,
        `  name: ${name}`,
        `  reason: ${problemReason}`,
      ],
      problemReason,
    );
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
  findings: GraphFinding[];
  projectPathAliases?: Map<string, string>;
  projectPaths: string[];
}): NormalizedGraphRules {
  const allowRefsByLabel = new Map<string, Map<string, GraphRuleRefAllow>>();
  const depsByLabel = new Map<string, GraphRuleDepDeny[]>();
  const refsByLabel = new Map<string, Map<string, GraphRuleRefDeny>>();
  const projectPathSet = new Set(options.projectPaths);
  const addConfigFinding = (
    details: readonly string[],
    reason: string,
  ): void => {
    addRuleEntryConfigFinding(
      options.config,
      options.findings,
      details,
      reason,
    );
  };

  for (const [rawLabel, rawRule] of Object.entries(
    getRulesRecord(options.config, options.findings),
  )) {
    const label = rawLabel.trim();

    if (!label) {
      const reason = 'graph.rules keys must be non-empty labels.';
      addConfigFinding(['  field: graph.rules', `  reason: ${reason}`], reason);
      continue;
    }

    if (!isPlainRecord(rawRule)) {
      const reason = 'each graph rule must be an object.';
      addConfigFinding(
        [
          `  field: graph.rules.${rawLabel}`,
          `  value: ${formatUnknownValue(rawRule)}`,
          '  reason: each graph rule must be an object.',
        ],
        reason,
      );
      continue;
    }

    for (const key of Object.keys(rawRule)) {
      if (graphRuleKeys.has(key)) {
        continue;
      }

      const reason = 'unknown graph rule field.';
      addConfigFinding(
        [
          `  field: graph.rules.${label}.${key}`,
          `  value: ${formatUnknownValue(rawRule[key])}`,
          '  reason: unknown graph rule field.',
        ],
        reason,
      );
    }

    if (rawRule.deny !== undefined && !isPlainRecord(rawRule.deny)) {
      const reason = 'graph rule deny must be an object.';
      addConfigFinding(
        [
          `  field: graph.rules.${label}.deny`,
          `  value: ${formatUnknownValue(rawRule.deny)}`,
          '  reason: graph rule deny must be an object.',
        ],
        reason,
      );
      continue;
    }

    const deny = isPlainRecord(rawRule.deny) ? rawRule.deny : undefined;

    if (deny) {
      for (const key of Object.keys(deny)) {
        if (graphRuleDenyKeys.has(key)) {
          continue;
        }

        const reason = 'unknown graph rule deny field.';
        addConfigFinding(
          [
            `  field: graph.rules.${label}.deny.${key}`,
            `  value: ${formatUnknownValue(deny[key])}`,
            '  reason: unknown graph rule deny field.',
          ],
          reason,
        );
      }
    }

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
            findings: options.findings,
            index,
            label,
            projectPathAliases: options.projectPathAliases,
            projectPathSet,
            refsByLabel,
            ruleKind: 'deny',
          });
        }
      } else {
        const reason = 'deny.refs must be an array.';
        addConfigFinding(
          [
            `  field: graph.rules.${label}.deny.refs`,
            `  value: ${formatUnknownValue(denyRefs)}`,
            `  reason: ${reason}`,
          ],
          reason,
        );
      }
    }

    const deps = deny?.deps;

    if (
      shouldNormalizeRuleKind(options.include, 'deps') &&
      deps !== undefined
    ) {
      if (Array.isArray(deps)) {
        for (const [index, entry] of deps.entries()) {
          addNormalizedDep({
            config: options.config,
            depsByLabel,
            entry,
            findings: options.findings,
            index,
            label,
          });
        }
      } else {
        const reason = 'deny.deps must be an array.';
        addConfigFinding(
          [
            `  field: graph.rules.${label}.deny.deps`,
            `  value: ${formatUnknownValue(deps)}`,
            `  reason: ${reason}`,
          ],
          reason,
        );
      }
    }

    if (rawRule.allow !== undefined && !isPlainRecord(rawRule.allow)) {
      const reason = 'graph rule allow must be an object.';
      addConfigFinding(
        [
          `  field: graph.rules.${label}.allow`,
          `  value: ${formatUnknownValue(rawRule.allow)}`,
          '  reason: graph rule allow must be an object.',
        ],
        reason,
      );
      continue;
    }

    const allow = isPlainRecord(rawRule.allow) ? rawRule.allow : undefined;

    if (allow) {
      for (const key of Object.keys(allow)) {
        if (graphRuleAllowKeys.has(key)) {
          continue;
        }

        const reason = 'unknown graph rule allow field.';
        addConfigFinding(
          [
            `  field: graph.rules.${label}.allow.${key}`,
            `  value: ${formatUnknownValue(allow[key])}`,
            '  reason: unknown graph rule allow field.',
          ],
          reason,
        );
      }
    }

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
            findings: options.findings,
            index,
            label,
            projectPathAliases: options.projectPathAliases,
            projectPathSet,
            refsByLabel: allowRefsByLabel,
            ruleKind: 'allow',
          });
        }
      } else {
        const reason = 'allow.refs must be an array.';
        addConfigFinding(
          [
            `  field: graph.rules.${label}.allow.refs`,
            `  value: ${formatUnknownValue(allowRefs)}`,
            `  reason: ${reason}`,
          ],
          reason,
        );
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
    isPackageImportSpecifier(specifier) ||
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
