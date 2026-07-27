import type { ResolvedLiminaConfig } from '#config/runner';
import type { ImportRecord } from '#core/import-graph/context';
import type { PackageOwner } from '#core/workspace/actions';
import { normalizeSlashes, toRelativePath } from '#utils/path';
import { existsSync } from 'node:fs';
import path from 'pathe';
import type { CheckCounter } from '../check-reporting/stats';
import type { SourceFinding } from './findings';
import { addImportAuthorityConfigFinding } from './import-authority-config-findings';
import {
  compileOwnerGrants,
  isPlainConfigRecord,
} from './import-authority-grant-parser';
import type { CompiledImportAuthorityAllowRule } from './source-types';

function getRawAllow(config: ResolvedLiminaConfig): unknown {
  const source = config.source;
  if (!source) {
    return undefined;
  }

  const authority = source.importAuthority;
  return authority ? authority.allow : undefined;
}

function parseAllowRecord(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
}): Record<string, unknown> | null {
  const rawAllow = getRawAllow(options.config);
  if (rawAllow === undefined) {
    return {};
  }

  if (isPlainConfigRecord(rawAllow)) {
    return rawAllow;
  }

  options.checks.add();
  addImportAuthorityConfigFinding({
    field: 'source.importAuthority.allow',
    findings: options.findings,
    fix: 'use allow: { "@scope/package": [{ include: ["test/**/*.ts"], workspaceRootDependencies: ["@example/fixture"], reason: "..." }] }.',
    kind: 'allow-field',
    reason: 'allow must be an object keyed by source owner identity.',
    value: rawAllow,
  });
  return null;
}

function compileAllowEntry(options: {
  checks: CheckCounter;
  findings: SourceFinding[];
  grants: unknown;
  ownerIdentity: string;
}): CompiledImportAuthorityAllowRule[] {
  options.checks.add();
  return compileOwnerGrants(options);
}

export function collectImportAuthorityAllowRules(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
}): CompiledImportAuthorityAllowRule[] {
  const rawAllow = parseAllowRecord(options);
  if (!rawAllow) {
    return [];
  }

  return Object.entries(rawAllow).flatMap(([ownerIdentity, grants]) =>
    compileAllowEntry({
      checks: options.checks,
      findings: options.findings,
      grants,
      ownerIdentity,
    }),
  );
}

export function hasImportAuthorityWorkspaceRootDependencyGrants(
  rules: CompiledImportAuthorityAllowRule[],
): boolean {
  return rules.some((rule) => rule.packageMatchers.length > 0);
}

function needsWorkspaceRootManifest(
  rules: CompiledImportAuthorityAllowRule[],
): boolean {
  return hasImportAuthorityWorkspaceRootDependencyGrants(rules);
}

export function addImportAuthorityRootManifestConfigProblems(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
}): void {
  options.checks.add();
  if (!needsWorkspaceRootManifest(options.importAuthorityAllowRules)) {
    return;
  }

  const rootPackageJsonPath = path.join(options.config.rootDir, 'package.json');
  if (existsSync(rootPackageJsonPath)) {
    return;
  }

  addImportAuthorityConfigFinding({
    field: 'source.importAuthority.allow',
    findings: options.findings,
    fix: 'create a workspace root package.json, or remove workspaceRootDependencies grants.',
    kind: 'root-dependency-grants',
    packageJsonPath: rootPackageJsonPath,
    reason:
      'workspaceRootDependencies grants require a workspace root package.json.',
  });
}

export function getSourceOwnerIdentity(options: {
  config: ResolvedLiminaConfig;
  owner: PackageOwner;
}): string {
  const relativeDirectory = normalizeSlashes(
    toRelativePath(options.config.rootDir, options.owner.directory),
  );

  return options.owner.name ?? relativeDirectory;
}

function getImportAuthorityRuleContext(options: {
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  owner: PackageOwner;
}): {
  configRootRelativeFilePath: string;
  ownerIdentity: string;
} {
  return {
    configRootRelativeFilePath: normalizeSlashes(
      toRelativePath(options.config.rootDir, options.importRecord.filePath),
    ),
    ownerIdentity: getSourceOwnerIdentity(options),
  };
}

function matchesRuleOwner(
  rule: CompiledImportAuthorityAllowRule,
  ownerIdentity: string,
): boolean {
  return rule.ownerIdentity === ownerIdentity;
}

function matchesRuleFile(
  rule: CompiledImportAuthorityAllowRule,
  filePath: string,
): boolean {
  if (rule.appliesToAllGovernedOwnerSources) {
    return true;
  }

  return rule.includeMatchers.some((matches) => matches(filePath));
}

function isImportAuthorityRuleInScope(
  rule: CompiledImportAuthorityAllowRule,
  context: {
    configRootRelativeFilePath: string;
    ownerIdentity: string;
  },
): boolean {
  if (!matchesRuleOwner(rule, context.ownerIdentity)) {
    return false;
  }

  return matchesRuleFile(rule, context.configRootRelativeFilePath);
}

function matchesPackage(
  rule: CompiledImportAuthorityAllowRule,
  packageName: string,
): boolean {
  return rule.packageMatchers.some((matches) => matches(packageName));
}

function matchesGrant(options: {
  context: ReturnType<typeof getImportAuthorityRuleContext>;
  packageName: string;
  rule: CompiledImportAuthorityAllowRule;
}): boolean {
  const conditions = [
    isImportAuthorityRuleInScope(options.rule, options.context),
    matchesPackage(options.rule, options.packageName),
  ];

  return conditions.every(Boolean);
}

export function findMatchingWorkspaceRootDependencyGrant(options: {
  config: ResolvedLiminaConfig;
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  packageName: string;
}): CompiledImportAuthorityAllowRule | undefined {
  if (options.importAuthorityAllowRules.length === 0) {
    return undefined;
  }

  const context = getImportAuthorityRuleContext(options);
  return options.importAuthorityAllowRules.find((rule) =>
    matchesGrant({ context, packageName: options.packageName, rule }),
  );
}

export function formatImportAuthorityGrantPath(
  rule: CompiledImportAuthorityAllowRule,
): string {
  return `source.importAuthority.allow[${JSON.stringify(rule.ownerIdentity)}][${rule.grantIndex}]`;
}
