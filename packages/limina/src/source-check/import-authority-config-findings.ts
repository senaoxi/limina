import type { ResolvedLiminaConfig } from '#config/runner';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { CheckCounter } from '../check-reporting/stats';
import { createSourceDiagnosticFinding } from './finding-utils';
import type { SourceFinding, SourceFindingFactsByCode } from './findings';

interface ConfigFindingOptions {
  field: string;
  findings: SourceFinding[];
  fix?: string;
  grantIndex?: number;
  kind: SourceFindingFactsByCode[typeof LIMINA_CHECK_ISSUE_CODES.sourceImportAuthorityInvalid]['kind'];
  ownerIdentity?: string;
  packageJsonPath?: string;
  reason: string;
  suggestion?: string;
  value?: unknown;
  valueLines?: readonly string[];
}

function createFixLines(fix: string | undefined): string[] {
  return fix ? [`  fix: ${fix}`] : [];
}

function createSuggestionLines(suggestion: string | undefined): string[] {
  return suggestion ? ['  did you mean:', `    - ${suggestion}`] : [];
}

export function addImportAuthorityConfigFinding(
  options: ConfigFindingOptions,
): void {
  const title = 'Invalid source import authority config';
  const lines = [
    `${title}:`,
    `  field: ${options.field}`,
    ...(options.valueLines ?? []),
    `  reason: ${options.reason}`,
    ...createFixLines(options.fix),
    ...createSuggestionLines(options.suggestion),
  ];

  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourceImportAuthorityInvalid,
      facts: {
        field: options.field,
        grantIndex: options.grantIndex,
        kind: options.kind,
        ownerIdentity: options.ownerIdentity,
        packageManifestPath: options.packageJsonPath,
        suggestion: options.suggestion,
        value: options.value,
      },
      fix: options.fix,
      lines,
      locations: [{ label: 'field', scope: options.field }],
      ownerName: options.ownerIdentity,
      packageJsonPath: options.packageJsonPath,
      reason: options.reason,
      scope: options.field,
      title,
    }),
  );
}

interface OwnerKeyRule {
  matches: (ownerKey: string) => boolean;
  reason: string;
}

const ownerKeyRules: OwnerKeyRule[] = [
  {
    matches: (ownerKey) => ownerKey.trim().length === 0,
    reason:
      'source.importAuthority.allow keys must be non-empty source owner identities.',
  },
  {
    matches: (ownerKey) => ['*', '<root>', '<workspace>'].includes(ownerKey),
    reason: 'global source import authority owner keys are not supported.',
  },
  {
    matches: (ownerKey) => /[*?[\]{}()!+]/u.test(ownerKey),
    reason:
      'owner glob keys are not supported; keys must match known workspace source owners.',
  },
];

function getImportAuthorityOwnerKeyReason(ownerKey: string): string {
  const matchedRule = ownerKeyRules.find((rule) => rule.matches(ownerKey));

  return (
    matchedRule?.reason ??
    'source.importAuthority.allow keys must match known workspace source owners.'
  );
}

function createEditDistanceRow(options: {
  leftCharacter: string;
  leftIndex: number;
  previous: number[];
  rightCharacters: string[];
}): number[] {
  const current = [options.leftIndex + 1];

  for (const [
    rightIndex,
    rightCharacter,
  ] of options.rightCharacters.entries()) {
    const substitutionCost = options.leftCharacter === rightCharacter ? 0 : 1;
    current[rightIndex + 1] = Math.min(
      current[rightIndex]! + 1,
      options.previous[rightIndex + 1]! + 1,
      options.previous[rightIndex]! + substitutionCost,
    );
  }

  return current;
}

function getEditDistance(left: string, right: string): number {
  const leftCharacters = Array.from(left);
  const rightCharacters = Array.from(right);
  const previous = Array.from(
    { length: rightCharacters.length + 1 },
    (_, index) => index,
  );

  for (const [leftIndex, leftCharacter] of leftCharacters.entries()) {
    previous.splice(
      0,
      previous.length,
      ...createEditDistanceRow({
        leftCharacter,
        leftIndex,
        previous,
        rightCharacters,
      }),
    );
  }

  return previous[rightCharacters.length] ?? Number.POSITIVE_INFINITY;
}

function getSuggestedOwner(options: {
  bestDistance: number;
  bestSuggestion: string | undefined;
  ownerKey: string;
}): string | undefined {
  const threshold = Math.max(3, Math.floor(options.ownerKey.length / 3));

  return options.bestDistance <= threshold ? options.bestSuggestion : undefined;
}

function getClosestOwnerSuggestion(
  ownerKey: string,
  ownerIdentities: string[],
): string | undefined {
  let bestSuggestion: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const ownerIdentity of ownerIdentities) {
    const distance = getEditDistance(ownerKey, ownerIdentity);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestSuggestion = ownerIdentity;
    }
  }

  return getSuggestedOwner({ bestDistance, bestSuggestion, ownerKey });
}

function getRawAllow(config: ResolvedLiminaConfig): unknown {
  const source = config.source;
  if (!source) {
    return undefined;
  }

  const importAuthority = source.importAuthority;
  return importAuthority ? importAuthority.allow : undefined;
}

function isObjectValue(value: unknown): value is object {
  if (!value) {
    return false;
  }

  return typeof value === 'object';
}

function asAllowRecord(value: unknown): Record<string, unknown> | null {
  if (!isObjectValue(value)) {
    return null;
  }

  if (Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function getAllowRecord(
  config: ResolvedLiminaConfig,
): Record<string, unknown> | null {
  return asAllowRecord(getRawAllow(config));
}

function addUnknownOwnerFinding(options: {
  findings: SourceFinding[];
  ownerIdentities: Set<string>;
  ownerKey: string;
  sortedOwnerIdentities: string[];
}): void {
  if (options.ownerIdentities.has(options.ownerKey)) {
    return;
  }

  addImportAuthorityConfigFinding({
    field: `source.importAuthority.allow[${JSON.stringify(options.ownerKey)}]`,
    findings: options.findings,
    fix: 'use an existing workspace package name, or the config-root-relative owner directory for nameless owners.',
    kind: 'unknown-owner',
    ownerIdentity: options.ownerKey,
    reason: getImportAuthorityOwnerKeyReason(options.ownerKey),
    suggestion: getClosestOwnerSuggestion(
      options.ownerKey,
      options.sortedOwnerIdentities,
    ),
    valueLines: [`  owner: ${options.ownerKey}`],
  });
}

export function addImportAuthorityOwnerConfigProblems(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
  ownerIdentities: Set<string>;
}): void {
  const rawAllow = getAllowRecord(options.config);
  if (!rawAllow) {
    return;
  }

  const sortedOwnerIdentities = [...options.ownerIdentities].sort();
  for (const ownerKey of Object.keys(rawAllow)) {
    options.checks.add();
    addUnknownOwnerFinding({
      findings: options.findings,
      ownerIdentities: options.ownerIdentities,
      ownerKey,
      sortedOwnerIdentities,
    });
  }
}
