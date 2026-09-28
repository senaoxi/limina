import rawPicomatch from 'picomatch';
import type { CheckCounter } from '../check-reporting/stats';
import type { SourceFinding } from './findings';
import { addImportAuthorityConfigFinding } from './import-authority-config-findings';
import type { CompiledImportAuthorityAllowRule } from './source-types';
import {
  isInvalidConfigRootPattern,
  normalizeWorkspacePattern,
} from './workspace-patterns';

const picomatch = rawPicomatch as unknown as (
  pattern: string,
  options?: { dot?: boolean; posixSlashes?: boolean },
) => (value: string) => boolean;

interface CompileGrantOptions {
  findings: SourceFinding[];
  grant: unknown;
  grantIndex: number;
  ownerIdentity: string;
}

interface ParsedInclude {
  configured: boolean;
  patterns: string[];
}

function isPlainConfigRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    return false;
  }

  return !Array.isArray(value);
}

function createValueMatcher(pattern: string): (value: string) => boolean {
  if (/[*?[\]{}()!+]/u.test(pattern)) {
    return picomatch(pattern, { dot: true, posixSlashes: true });
  }

  return (value) => value === pattern;
}

function normalizeInclude(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((file) =>
      typeof file === 'string' ? normalizeWorkspacePattern(file) : '',
    )
    .filter((file) => file.length > 0);
}

function parseGrantRecord(
  options: CompileGrantOptions,
): Record<string, unknown> | null {
  if (isPlainConfigRecord(options.grant)) {
    return options.grant;
  }

  addImportAuthorityConfigFinding({
    field: `source.importAuthority.allow[${JSON.stringify(options.ownerIdentity)}][${options.grantIndex}]`,
    findings: options.findings,
    grantIndex: options.grantIndex,
    kind: 'grant',
    ownerIdentity: options.ownerIdentity,
    reason:
      'importAuthority allow grants must be objects with workspaceRootDependencies and reason fields.',
    value: options.grant,
  });
  return null;
}

function hasEmptyConfiguredInclude(options: {
  configured: boolean;
  patterns: string[];
}): boolean {
  return options.configured && options.patterns.length === 0;
}

function addEmptyIncludeFinding(options: {
  base: CompileGrantOptions;
  value: unknown;
}): void {
  addImportAuthorityConfigFinding({
    field: `source.importAuthority.allow[${JSON.stringify(options.base.ownerIdentity)}][${options.base.grantIndex}].include`,
    findings: options.base.findings,
    grantIndex: options.base.grantIndex,
    kind: 'grant-include',
    ownerIdentity: options.base.ownerIdentity,
    reason: 'include must be a non-empty string array when configured.',
    value: options.value,
  });
}

function addInvalidIncludeFinding(options: {
  base: CompileGrantOptions;
  pattern: string;
}): void {
  addImportAuthorityConfigFinding({
    field: `source.importAuthority.allow[${JSON.stringify(options.base.ownerIdentity)}][${options.base.grantIndex}].include`,
    findings: options.base.findings,
    grantIndex: options.base.grantIndex,
    kind: 'grant-include',
    ownerIdentity: options.base.ownerIdentity,
    reason: 'include must use positive config-root-relative globs.',
    value: options.pattern,
    valueLines: [`  file: ${options.pattern}`],
  });
}

function parseGrantInclude(options: {
  base: CompileGrantOptions;
  grant: Record<string, unknown>;
}): ParsedInclude | null {
  const patterns = normalizeInclude(options.grant.include);
  const configured = options.grant.include !== undefined;
  if (hasEmptyConfiguredInclude({ configured, patterns })) {
    addEmptyIncludeFinding({
      base: options.base,
      value: options.grant.include,
    });
    return null;
  }

  const invalidPattern = patterns.find(isInvalidConfigRootPattern);
  if (invalidPattern) {
    addInvalidIncludeFinding({ base: options.base, pattern: invalidPattern });
    return null;
  }

  return { configured, patterns };
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }

  return value.every(
    (entry) => typeof entry === 'string' && entry.trim().length > 0,
  );
}

function parseGrantPackages(options: {
  base: CompileGrantOptions;
  grant: Record<string, unknown>;
}): string[] | null {
  if (isNonEmptyStringArray(options.grant.workspaceRootDependencies)) {
    return options.grant.workspaceRootDependencies;
  }

  addImportAuthorityConfigFinding({
    field: `source.importAuthority.allow[${JSON.stringify(options.base.ownerIdentity)}][${options.base.grantIndex}].workspaceRootDependencies`,
    findings: options.base.findings,
    grantIndex: options.base.grantIndex,
    kind: 'grant-packages',
    ownerIdentity: options.base.ownerIdentity,
    reason: 'workspaceRootDependencies must be a non-empty string array.',
    value: options.grant.workspaceRootDependencies,
  });
  return null;
}

function parseGrantReason(options: {
  base: CompileGrantOptions;
  grant: Record<string, unknown>;
}): string | null {
  const reason = options.grant.reason;
  if (typeof reason === 'string' && reason.trim().length > 0) {
    return reason.trim();
  }

  addImportAuthorityConfigFinding({
    field: `source.importAuthority.allow[${JSON.stringify(options.base.ownerIdentity)}][${options.base.grantIndex}].reason`,
    findings: options.base.findings,
    grantIndex: options.base.grantIndex,
    kind: 'grant-reason',
    ownerIdentity: options.base.ownerIdentity,
    reason: 'reason must be a non-empty string.',
    value: reason,
  });
  return null;
}

function compileGrantDetails(options: {
  base: CompileGrantOptions;
  grant: Record<string, unknown>;
  include: ParsedInclude;
}): CompiledImportAuthorityAllowRule | null {
  const packages = parseGrantPackages(options);
  if (!packages) {
    return null;
  }

  const reason = parseGrantReason(options);
  if (!reason) {
    return null;
  }

  return {
    appliesToAllGovernedOwnerSources: !options.include.configured,
    grantIndex: options.base.grantIndex,
    includeMatchers: options.include.patterns.map((file) =>
      picomatch(file, { dot: true, posixSlashes: true }),
    ),
    ownerIdentity: options.base.ownerIdentity,
    packageMatchers: packages.map((value) => createValueMatcher(value.trim())),
    reason,
  };
}

function compileGrant(
  options: CompileGrantOptions,
): CompiledImportAuthorityAllowRule | null {
  const grant = parseGrantRecord(options);
  if (!grant) {
    return null;
  }

  const include = parseGrantInclude({ base: options, grant });
  if (!include) {
    return null;
  }

  return compileGrantDetails({ base: options, grant, include });
}

function addCompiledGrant(options: {
  base: Omit<CompileGrantOptions, 'grant' | 'grantIndex'>;
  grant: unknown;
  grantIndex: number;
  rules: CompiledImportAuthorityAllowRule[];
}): void {
  const rule = compileGrant({
    ...options.base,
    grant: options.grant,
    grantIndex: options.grantIndex,
  });
  if (rule) {
    options.rules.push(rule);
  }
}

export function compileOwnerGrants(options: {
  checks: CheckCounter;
  findings: SourceFinding[];
  grants: unknown;
  ownerIdentity: string;
}): CompiledImportAuthorityAllowRule[] {
  if (!Array.isArray(options.grants)) {
    addImportAuthorityConfigFinding({
      field: `source.importAuthority.allow[${JSON.stringify(options.ownerIdentity)}]`,
      findings: options.findings,
      kind: 'grant',
      ownerIdentity: options.ownerIdentity,
      reason: 'allow owner entries must be arrays of grants.',
      value: options.grants,
    });
    return [];
  }

  const rules: CompiledImportAuthorityAllowRule[] = [];
  for (const [grantIndex, grant] of options.grants.entries()) {
    options.checks.add();
    addCompiledGrant({
      base: {
        findings: options.findings,
        ownerIdentity: options.ownerIdentity,
      },
      grant,
      grantIndex,
      rules,
    });
  }

  return rules;
}

export { isPlainConfigRecord };
