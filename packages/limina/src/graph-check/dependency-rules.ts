import { getPackageRootSpecifier } from '#core/workspace/actions';
import {
  isPackageImportSpecifier,
  isRelativeSpecifier,
  isUrlOrDataOrFileSpecifier,
} from '#utils/module-specifier';
import { isBuiltin } from 'node:module';
import path from 'pathe';
import type {
  GraphRuleDependencyDeny,
  LabelSelection,
  NormalizedGraphRules,
} from './rule-types';

function isMatchesWildcardParts(options: {
  prefix: string;
  suffix: string;
  value: string;
}): boolean {
  return (
    options.value.startsWith(options.prefix) &&
    options.value.endsWith(options.suffix)
  );
}

function isMatchWildcardPattern(pattern: string, value: string): boolean {
  if (pattern === value) {
    return true;
  }
  const wildcardIndex = pattern.indexOf('*');
  if (wildcardIndex === -1) {
    return false;
  }
  return isMatchesWildcardParts({
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
): Pick<
  GraphRuleDependencyDeny,
  'matchAllNodeBuiltins' | 'normalizedName'
> | null {
  if (name === 'node:*') {
    return { matchAllNodeBuiltins: true, normalizedName: '*' };
  }
  const normalizedName = normalizeNodeBuiltinName(name);
  return isBuiltin(name)
    ? { matchAllNodeBuiltins: false, normalizedName }
    : null;
}

function createNodeBuiltinDependency(
  name: string,
  reason: string,
): GraphRuleDependencyDeny | null {
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

function createPackageImportDependency(
  name: string,
  reason: string,
): GraphRuleDependencyDeny | null {
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

function createPackageDependency(
  name: string,
  reason: string,
): GraphRuleDependencyDeny | null {
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

export function createNormalizedDependency(
  name: string,
  reason: string,
): GraphRuleDependencyDeny | null {
  return (
    createNodeBuiltinDependency(name, reason) ??
    createPackageImportDependency(name, reason) ??
    createPackageDependency(name, reason)
  );
}

export function isNodeBuiltinSpecifier(specifier: string): boolean {
  return isBuiltin(specifier);
}

function getSelectedLabels(labels: LabelSelection): readonly string[] {
  if (labels === null) {
    return [];
  }
  return typeof labels === 'string' ? [labels] : labels;
}

function getRuleDependencies(
  rules: NormalizedGraphRules,
  labels: LabelSelection,
): GraphRuleDependencyDeny[] {
  return getSelectedLabels(labels).flatMap(
    (label) => rules.depsByLabel.get(label) ?? [],
  );
}

export function getDeniedDependencyRuleForPackage(
  rules: NormalizedGraphRules,
  labels: LabelSelection,
  packageName: string,
): GraphRuleDependencyDeny | null {
  return (
    getRuleDependencies(rules, labels).find(
      (rule) => rule.kind === 'package' && rule.normalizedName === packageName,
    ) ?? null
  );
}

function findPackageImportRule(
  dependencies: readonly GraphRuleDependencyDeny[],
  specifier: string,
): GraphRuleDependencyDeny | null {
  return (
    dependencies.find(
      (rule) =>
        rule.kind === 'package-import' &&
        isMatchWildcardPattern(rule.normalizedName, specifier),
    ) ?? null
  );
}

function isMatchesNodeRule(
  rule: GraphRuleDependencyDeny,
  normalizedSpecifier: string,
): boolean {
  return (
    rule.kind === 'node-builtin' &&
    (rule.matchAllNodeBuiltins || rule.normalizedName === normalizedSpecifier)
  );
}

function findNodeBuiltinRule(
  dependencies: readonly GraphRuleDependencyDeny[],
  specifier: string,
): GraphRuleDependencyDeny | null {
  if (!isNodeBuiltinSpecifier(specifier)) {
    return null;
  }
  const normalizedSpecifier = normalizeNodeBuiltinName(specifier);
  return (
    dependencies.find((rule) => isMatchesNodeRule(rule, normalizedSpecifier)) ??
    null
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
  dependencies: readonly GraphRuleDependencyDeny[],
  specifier: string,
): GraphRuleDependencyDeny | null {
  return (
    findPackageImportRule(dependencies, specifier) ??
    findNodeBuiltinRule(dependencies, specifier)
  );
}

export function getDeniedDependencyRuleForSpecifier(
  rules: NormalizedGraphRules,
  labels: LabelSelection,
  specifier: string,
): GraphRuleDependencyDeny | null {
  const directRule = findDirectDependencyRule(
    getRuleDependencies(rules, labels),
    specifier,
  );
  if (directRule !== null) {
    return directRule;
  }
  return isNonPackageDependencySpecifier(specifier)
    ? null
    : getDeniedDependencyRuleForPackage(
        rules,
        labels,
        getPackageRootSpecifier(specifier),
      );
}
