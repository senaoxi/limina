import path from 'pathe';

import type { ResolvedLiminaConfig } from '#config/runner';
import { normalizeAbsolutePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type {
  AllowlistEntry,
  AllowlistEntryCollection,
} from './allowlist-types';
import { formatUnknownValue, isPlainRecord } from './config-values';
import { createProofFinding, type ProofFindingForCode } from './findings';

interface InvalidAllowlistConfigOptions {
  config: ResolvedLiminaConfig;
  configuredPath?: string;
  field: string;
  ruleIndex?: number;
  value: unknown;
  violation:
    | 'absolute-path'
    | 'empty-file'
    | 'empty-reason'
    | 'entry-not-object'
    | 'not-array';
}

interface ParsedAllowlistEntry {
  entry?: AllowlistEntry;
  finding?: ProofFindingForCode<
    typeof LIMINA_CHECK_ISSUE_CODES.proofAllowlistInvalid
  >;
}

type EntryValidator = (
  config: ResolvedLiminaConfig,
  entry: Record<string, unknown>,
  index: number,
) => ParsedAllowlistEntry | null;

const violationReason = {
  'absolute-path': 'allowlist file must be relative to config.rootDir.',
  'empty-file': 'allowlist file must be a non-empty string.',
  'empty-reason': 'allowlist reason must be a non-empty string.',
  'entry-not-object':
    'allowlist entries must be objects with non-empty file and reason fields.',
  'not-array': 'proof.allowlist must be an array.',
} as const;

function getRuleScope(field: string): string {
  return field.includes('[') ? 'allowlist rule' : 'allowlist field';
}

function createDetailLines(options: InvalidAllowlistConfigOptions): string[] {
  const reason = violationReason[options.violation];

  return [
    'Invalid proof allowlist config:',
    `  field: ${options.field}`,
    `  value: ${formatUnknownValue(options.value)}`,
    `  reason: ${reason}`,
  ];
}

function createInvalidAllowlistFinding(
  options: InvalidAllowlistConfigOptions,
): ProofFindingForCode<typeof LIMINA_CHECK_ISSUE_CODES.proofAllowlistInvalid> {
  const detailLines = createDetailLines(options);
  const reason = violationReason[options.violation];

  return createProofFinding({
    code: LIMINA_CHECK_ISSUE_CODES.proofAllowlistInvalid,
    evidence: [{ label: 'diagnostic', lines: [...detailLines] }],
    facts: {
      configuredPath: options.configuredPath,
      field: options.field,
      kind: 'config-entry',
      repositoryRoot: normalizeAbsolutePath(options.config.rootDir),
      ruleIndex: options.ruleIndex,
      value: options.value,
      violation: options.violation,
    },
    filePath: options.config.configPath,
    locations: [
      { filePath: options.config.configPath, label: 'Limina config' },
      { label: getRuleScope(options.field), scope: options.field },
    ],
    presentation: {
      detailLines,
      title: 'Invalid proof allowlist config',
    },
    reason,
    scope: options.field,
  });
}

function validateFileValue(
  config: ResolvedLiminaConfig,
  entry: Record<string, unknown>,
  index: number,
): ParsedAllowlistEntry | null {
  const fileValue = entry.file;

  if (typeof fileValue === 'string' && fileValue.trim().length > 0) {
    return null;
  }

  return {
    finding: createInvalidAllowlistFinding({
      config,
      field: `proof.allowlist[${index}].file`,
      ruleIndex: index,
      value: fileValue,
      violation: 'empty-file',
    }),
  };
}

function getConfiguredPath(entry: Record<string, unknown>): string | undefined {
  return typeof entry.file === 'string' ? entry.file.trim() : undefined;
}

function validateReasonValue(
  config: ResolvedLiminaConfig,
  entry: Record<string, unknown>,
  index: number,
): ParsedAllowlistEntry | null {
  const reasonValue = entry.reason;

  if (typeof reasonValue === 'string' && reasonValue.trim().length > 0) {
    return null;
  }

  return {
    finding: createInvalidAllowlistFinding({
      config,
      configuredPath: getConfiguredPath(entry),
      field: `proof.allowlist[${index}].reason`,
      ruleIndex: index,
      value: reasonValue,
      violation: 'empty-reason',
    }),
  };
}

function isAbsoluteConfiguredPath(filePath: string): boolean {
  return path.isAbsolute(filePath) || /^[A-Za-z]:[\\/]/u.test(filePath);
}

function validateRelativePath(
  config: ResolvedLiminaConfig,
  entry: Record<string, unknown>,
  index: number,
): ParsedAllowlistEntry | null {
  const fileValue = String(entry.file);
  const configuredPath = fileValue.trim();

  if (!isAbsoluteConfiguredPath(configuredPath)) {
    return null;
  }

  return {
    finding: createInvalidAllowlistFinding({
      config,
      configuredPath,
      field: `proof.allowlist[${index}].file`,
      ruleIndex: index,
      value: entry.file,
      violation: 'absolute-path',
    }),
  };
}

const entryValidators: readonly EntryValidator[] = [
  validateFileValue,
  validateReasonValue,
  validateRelativePath,
];

function findEntryValidationResult(
  config: ResolvedLiminaConfig,
  entry: Record<string, unknown>,
  index: number,
): ParsedAllowlistEntry | null {
  for (const validate of entryValidators) {
    const result = validate(config, entry, index);

    if (result !== null) {
      return result;
    }
  }

  return null;
}

function createValidAllowlistEntry(
  config: ResolvedLiminaConfig,
  entry: Record<string, unknown>,
  index: number,
): ParsedAllowlistEntry {
  const configuredPath = String(entry.file).trim();

  return {
    entry: {
      configuredPath,
      filePath: normalizeAbsolutePath(
        path.resolve(config.rootDir, configuredPath),
      ),
      reason: String(entry.reason).trim(),
      ruleIndex: index,
    },
  };
}

function parseAllowlistEntry(
  config: ResolvedLiminaConfig,
  rawEntry: unknown,
  index: number,
): ParsedAllowlistEntry {
  if (!isPlainRecord(rawEntry)) {
    return {
      finding: createInvalidAllowlistFinding({
        config,
        field: `proof.allowlist[${index}]`,
        ruleIndex: index,
        value: rawEntry,
        violation: 'entry-not-object',
      }),
    };
  }

  return (
    findEntryValidationResult(config, rawEntry, index) ??
    createValidAllowlistEntry(config, rawEntry, index)
  );
}

function appendParsedEntry(
  collection: AllowlistEntryCollection,
  parsed: ParsedAllowlistEntry,
): void {
  if (parsed.entry !== undefined) {
    collection.entries.push(parsed.entry);
  }

  if (parsed.finding !== undefined) {
    collection.findings.push(parsed.finding);
  }
}

function collectArrayEntries(
  config: ResolvedLiminaConfig,
  rawEntries: readonly unknown[],
): AllowlistEntryCollection {
  const collection: AllowlistEntryCollection = { entries: [], findings: [] };

  for (const [index, rawEntry] of rawEntries.entries()) {
    appendParsedEntry(collection, parseAllowlistEntry(config, rawEntry, index));
  }

  return collection;
}

function createInvalidAllowlistCollection(
  config: ResolvedLiminaConfig,
  rawEntries: unknown,
): AllowlistEntryCollection {
  return {
    entries: [],
    findings: [
      createInvalidAllowlistFinding({
        config,
        field: 'proof.allowlist',
        value: rawEntries,
        violation: 'not-array',
      }),
    ],
  };
}

function getRawAllowlistEntries(config: ResolvedLiminaConfig): unknown {
  return config.proof === undefined ? undefined : config.proof.allowlist;
}

export function collectAllowlistConfigEntries(
  config: ResolvedLiminaConfig,
): AllowlistEntryCollection {
  const rawEntries = getRawAllowlistEntries(config);

  if (rawEntries === undefined) {
    return { entries: [], findings: [] };
  }

  return Array.isArray(rawEntries)
    ? collectArrayEntries(config, rawEntries)
    : createInvalidAllowlistCollection(config, rawEntries);
}
