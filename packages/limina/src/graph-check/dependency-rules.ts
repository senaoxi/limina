import { getPackageRootSpecifier } from '#core/workspace/actions';
import {
  isPackageImportSpecifier,
  isRelativeSpecifier,
  isUrlOrDataOrFileSpecifier,
} from '#utils/module-specifier';
import { builtinModules } from 'node:module';
import path from 'pathe';
import type {
  GraphRuleDepDeny,
  LabelSelection,
  NormalizedGraphRules,
} from './rule-types';

const nodeBuiltinNames = new Set(
  builtinModules.flatMap((specifier) => {
    const normalized = specifier.startsWith('node:')
      ? specifier.slice('node:'.length)
      : specifier;
    return [normalized, `node:${normalized}`];
  }),
);

function matchesWildcardParts(options: {
  prefix: string;
  suffix: string;
  value: string;
}): boolean {
  if (!options.value.startsWith(options.prefix)) {
    return false;
  }
  return options.value.endsWith(options.suffix);
}

function matchWildcardPattern(pattern: string, value: string): boolean {
  if (pattern === value) {
    return true;
  }
  const wildcardIndex = pattern.indexOf('*');
  if (wildcardIndex === -1) {
    return false;
  }
  return matchesWildcardParts({
    prefix: pattern.slice(0, wildcardIndex),
    suffix: pattern.slice(wildcardIndex + 1),
    value,
  });
}

function normalizeNodeBuiltinName(name: string): string {
  return name.startsWith('node:') ? name.slice(5) : name;
}

function getNodeBuiltinRuleName(
  name: string,
): Pick<GraphRuleDepDeny, 'matchAllNodeBuiltins' | 'normalizedName'> | null {
  if (name === 'node:*') {
    return { matchAllNodeBuiltins: true, normalizedName: '*' };
  }
  const normalizedName = normalizeNodeBuiltinName(name);
  if (!nodeBuiltinNames.has(normalizedName)) {
    return null;
  }
  return { matchAllNodeBuiltins: false, normalizedName };
}

function createNodeBuiltinDep(
  name: string,
  reason: string,
): GraphRuleDepDeny | null {
  const normalized = getNodeBuiltinRuleName(name);
  if (normalized === null) {
    return null;
  }
  return {
    kind: 'node-builtin',
    matchAllNodeBuiltins: normalized.matchAllNodeBuiltins,
    name,
    normalizedName: normalized.normalizedName,
    reason,
  };
}

function createPackageImportDep(
  name: string,
  reason: string,
): GraphRuleDepDeny | null {
  if (!isPackageImportSpecifier(name)) {
    return null;
  }
  return {
    kind: 'package-import',
    matchAllNodeBuiltins: false,
    name,
    normalizedName: name,
    reason,
  };
}

function isInvalidPackageRuleName(name: string): boolean {
  return [
    isRelativeSpecifier(name),
    isUrlOrDataOrFileSpecifier(name),
    path.isAbsolute(name),
    getPackageRootSpecifier(name) !== name,
  ].some(Boolean);
}

function createPackageDep(
  name: string,
  reason: string,
): GraphRuleDepDeny | null {
  if (isInvalidPackageRuleName(name)) {
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

export function createNormalizedDep(
  name: string,
  reason: string,
): GraphRuleDepDeny | null {
  return (
    createNodeBuiltinDep(name, reason) ??
    createPackageImportDep(name, reason) ??
    createPackageDep(name, reason)
  );
}

export function isNodeBuiltinSpecifier(specifier: string): boolean {
  return nodeBuiltinNames.has(specifier);
}

function getSelectedLabels(labels: LabelSelection): readonly string[] {
  if (labels === null) {
    return [];
  }
  return typeof labels === 'string' ? [labels] : labels;
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

function findPackageImportRule(
  deps: readonly GraphRuleDepDeny[],
  specifier: string,
): GraphRuleDepDeny | null {
  return (
    deps.find(
      (rule) =>
        rule.kind === 'package-import' &&
        matchWildcardPattern(rule.normalizedName, specifier),
    ) ?? null
  );
}

function matchesNodeRule(
  rule: GraphRuleDepDeny,
  normalizedSpecifier: string,
): boolean {
  if (rule.kind !== 'node-builtin') {
    return false;
  }
  if (rule.matchAllNodeBuiltins) {
    return true;
  }
  return rule.normalizedName === normalizedSpecifier;
}

function findNodeBuiltinRule(
  deps: readonly GraphRuleDepDeny[],
  specifier: string,
): GraphRuleDepDeny | null {
  if (!isNodeBuiltinSpecifier(specifier)) {
    return null;
  }
  const normalizedSpecifier = normalizeNodeBuiltinName(specifier);
  return (
    deps.find((rule) => matchesNodeRule(rule, normalizedSpecifier)) ?? null
  );
}

function isNonPackageDependencySpecifier(specifier: string): boolean {
  return [
    isRelativeSpecifier(specifier),
    isPackageImportSpecifier(specifier),
    isUrlOrDataOrFileSpecifier(specifier),
    path.isAbsolute(specifier),
  ].some(Boolean);
}

function findDirectDependencyRule(
  deps: readonly GraphRuleDepDeny[],
  specifier: string,
): GraphRuleDepDeny | null {
  return (
    findPackageImportRule(deps, specifier) ??
    findNodeBuiltinRule(deps, specifier)
  );
}

export function getDeniedDepRuleForSpecifier(
  rules: NormalizedGraphRules,
  labels: LabelSelection,
  specifier: string,
): GraphRuleDepDeny | null {
  const directRule = findDirectDependencyRule(
    getRuleDeps(rules, labels),
    specifier,
  );
  if (directRule !== null) {
    return directRule;
  }
  if (isNonPackageDependencySpecifier(specifier)) {
    return null;
  }
  return getDeniedDepRuleForPackage(
    rules,
    labels,
    getPackageRootSpecifier(specifier),
  );
}
