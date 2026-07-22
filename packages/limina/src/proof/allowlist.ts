import { existsSync } from 'node:fs';
import path from 'pathe';

import type { ResolvedLiminaConfig } from '#config/runner';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import { formatUnknownValue, isPlainRecord } from './config-values';
import { addCoverage, type CoverageSource } from './coverage';
import { createProofFinding, type ProofFinding } from './findings';

export interface AllowlistEntry {
  configuredPath: string;
  filePath: string;
  reason: string;
  ruleIndex: number;
}

export interface AllowlistEntryCollection {
  entries: AllowlistEntry[];
  findings: ProofFinding[];
}

export function collectConfiguredAllowlistEntries(
  config: ResolvedLiminaConfig,
): AllowlistEntryCollection {
  const entries: AllowlistEntry[] = [];
  const findings: ProofFinding[] = [];
  const rawEntries = config.proof?.allowlist;

  if (rawEntries === undefined) {
    return {
      entries,
      findings,
    };
  }

  if (!Array.isArray(rawEntries)) {
    const detailLines = [
      'Invalid proof allowlist config:',
      '  field: proof.allowlist',
      `  value: ${formatUnknownValue(rawEntries)}`,
      '  reason: proof.allowlist must be an array.',
    ];

    findings.push(
      createProofFinding({
        code: LIMINA_CHECK_ISSUE_CODES.proofAllowlistInvalid,
        evidence: [{ label: 'diagnostic', lines: [...detailLines] }],
        facts: {
          field: 'proof.allowlist',
          kind: 'config-entry',
          repositoryRoot: normalizeAbsolutePath(config.rootDir),
          value: rawEntries,
          violation: 'not-array',
        },
        filePath: config.configPath,
        locations: [
          { filePath: config.configPath, label: 'Limina config' },
          { label: 'allowlist field', scope: 'proof.allowlist' },
        ],
        presentation: {
          detailLines,
          title: 'Invalid proof allowlist config',
        },
        reason: 'proof.allowlist must be an array.',
        scope: 'proof.allowlist',
      }),
    );
    return {
      entries,
      findings,
    };
  }

  for (const [index, entry] of rawEntries.entries()) {
    const field = `proof.allowlist[${index}]`;

    if (!isPlainRecord(entry)) {
      const reason =
        'allowlist entries must be objects with non-empty file and reason fields.';
      const detailLines = [
        'Invalid proof allowlist config:',
        `  field: ${field}`,
        `  value: ${formatUnknownValue(entry)}`,
        `  reason: ${reason}`,
      ];

      findings.push(
        createProofFinding({
          code: LIMINA_CHECK_ISSUE_CODES.proofAllowlistInvalid,
          evidence: [{ label: 'diagnostic', lines: [...detailLines] }],
          facts: {
            field,
            kind: 'config-entry',
            repositoryRoot: normalizeAbsolutePath(config.rootDir),
            ruleIndex: index,
            value: entry,
            violation: 'entry-not-object',
          },
          filePath: config.configPath,
          locations: [
            { filePath: config.configPath, label: 'Limina config' },
            { label: 'allowlist rule', scope: field },
          ],
          presentation: {
            detailLines,
            title: 'Invalid proof allowlist config',
          },
          reason,
          scope: field,
        }),
      );
      continue;
    }

    const fileValue = entry.file;
    const reasonValue = entry.reason;

    if (typeof fileValue !== 'string' || fileValue.trim().length === 0) {
      const reason = 'allowlist file must be a non-empty string.';
      const detailLines = [
        'Invalid proof allowlist config:',
        `  field: ${field}.file`,
        `  value: ${formatUnknownValue(fileValue)}`,
        `  reason: ${reason}`,
      ];

      findings.push(
        createProofFinding({
          code: LIMINA_CHECK_ISSUE_CODES.proofAllowlistInvalid,
          evidence: [{ label: 'diagnostic', lines: [...detailLines] }],
          facts: {
            field: `${field}.file`,
            kind: 'config-entry',
            repositoryRoot: normalizeAbsolutePath(config.rootDir),
            ruleIndex: index,
            value: fileValue,
            violation: 'empty-file',
          },
          filePath: config.configPath,
          locations: [
            { filePath: config.configPath, label: 'Limina config' },
            { label: 'allowlist field', scope: `${field}.file` },
          ],
          presentation: {
            detailLines,
            title: 'Invalid proof allowlist config',
          },
          reason,
          scope: `${field}.file`,
        }),
      );
      continue;
    }

    if (typeof reasonValue !== 'string' || reasonValue.trim().length === 0) {
      const reason = 'allowlist reason must be a non-empty string.';
      const detailLines = [
        'Invalid proof allowlist config:',
        `  field: ${field}.reason`,
        `  value: ${formatUnknownValue(reasonValue)}`,
        `  reason: ${reason}`,
      ];

      findings.push(
        createProofFinding({
          code: LIMINA_CHECK_ISSUE_CODES.proofAllowlistInvalid,
          evidence: [{ label: 'diagnostic', lines: [...detailLines] }],
          facts: {
            configuredPath: fileValue.trim(),
            field: `${field}.reason`,
            kind: 'config-entry',
            repositoryRoot: normalizeAbsolutePath(config.rootDir),
            ruleIndex: index,
            value: reasonValue,
            violation: 'empty-reason',
          },
          filePath: config.configPath,
          locations: [
            { filePath: config.configPath, label: 'Limina config' },
            { label: 'allowlist field', scope: `${field}.reason` },
          ],
          presentation: {
            detailLines,
            title: 'Invalid proof allowlist config',
          },
          reason,
          scope: `${field}.reason`,
        }),
      );
      continue;
    }

    const file = fileValue.trim();
    if (path.isAbsolute(file) || /^[A-Za-z]:[\\/]/u.test(file)) {
      const reason = 'allowlist file must be relative to config.rootDir.';
      const detailLines = [
        'Invalid proof allowlist config:',
        `  field: ${field}.file`,
        `  value: ${formatUnknownValue(fileValue)}`,
        `  reason: ${reason}`,
      ];

      findings.push(
        createProofFinding({
          code: LIMINA_CHECK_ISSUE_CODES.proofAllowlistInvalid,
          evidence: [{ label: 'diagnostic', lines: [...detailLines] }],
          facts: {
            configuredPath: file,
            field: `${field}.file`,
            kind: 'config-entry',
            repositoryRoot: normalizeAbsolutePath(config.rootDir),
            ruleIndex: index,
            value: fileValue,
            violation: 'absolute-path',
          },
          filePath: config.configPath,
          locations: [
            { filePath: config.configPath, label: 'Limina config' },
            { label: 'allowlist field', scope: `${field}.file` },
          ],
          presentation: {
            detailLines,
            title: 'Invalid proof allowlist config',
          },
          reason,
          scope: `${field}.file`,
        }),
      );
      continue;
    }

    entries.push({
      configuredPath: file,
      filePath: normalizeAbsolutePath(path.resolve(config.rootDir, file)),
      reason: reasonValue.trim(),
      ruleIndex: index,
    });
  }

  return {
    entries,
    findings,
  };
}

export function addAllowlistCoverage(options: {
  allowlistEntries: AllowlistEntry[];
  coverageByFile: Map<string, CoverageSource[]>;
  sourceFiles: Set<string>;
}): void {
  for (const entry of options.allowlistEntries) {
    if (!options.sourceFiles.has(entry.filePath)) {
      continue;
    }

    addCoverage(options.coverageByFile, entry.filePath, {
      configuredPath: entry.configuredPath,
      label: entry.reason,
      reason: entry.reason,
      resolvedPath: entry.filePath,
      ruleIndex: entry.ruleIndex,
      type: 'allowlist',
    });
  }
}

export function addAllowlistFindings(options: {
  allowlistEntries: AllowlistEntry[];
  baseCoverageByFile: Map<string, CoverageSource[]>;
  config: ResolvedLiminaConfig;
  findings: ProofFinding[];
  sourceFiles: Set<string>;
}): void {
  for (const entry of options.allowlistEntries) {
    if (!existsSync(entry.filePath)) {
      const detailLines = [
        'Typecheck proof allowlist references a missing file:',
        `  file: ${toRelativePath(options.config.rootDir, entry.filePath)}`,
      ];

      options.findings.push(
        createProofFinding({
          code: LIMINA_CHECK_ISSUE_CODES.proofAllowlistInvalid,
          evidence: [{ label: 'diagnostic', lines: [...detailLines] }],
          facts: {
            configuredPath: entry.configuredPath,
            coverage: [],
            kind: 'entry-coverage',
            repositoryRoot: normalizeAbsolutePath(options.config.rootDir),
            resolvedPath: entry.filePath,
            ruleIndex: entry.ruleIndex,
            sourcePath: entry.filePath,
            violation: 'missing-file',
          },
          filePath: entry.filePath,
          locations: [
            { filePath: entry.filePath, label: 'allowlist file' },
            {
              filePath: options.config.configPath,
              label: 'Limina config',
              scope: `proof.allowlist[${entry.ruleIndex}]`,
            },
          ],
          presentation: {
            detailLines,
            title: 'Typecheck proof allowlist references a missing file',
          },
          reason:
            'Every proof allowlist entry must reference an existing file.',
          scope: `proof.allowlist[${entry.ruleIndex}]`,
        }),
      );
      continue;
    }

    if (!options.sourceFiles.has(entry.filePath)) {
      const reason =
        'allowlist entries should only describe source files that proof would otherwise require coverage for.';
      const detailLines = [
        'Typecheck proof allowlist file is outside the configured source boundary:',
        `  file: ${toRelativePath(options.config.rootDir, entry.filePath)}`,
        `  reason: ${reason}`,
      ];

      options.findings.push(
        createProofFinding({
          code: LIMINA_CHECK_ISSUE_CODES.proofAllowlistInvalid,
          evidence: [{ label: 'diagnostic', lines: [...detailLines] }],
          facts: {
            configuredPath: entry.configuredPath,
            coverage: [],
            kind: 'entry-coverage',
            repositoryRoot: normalizeAbsolutePath(options.config.rootDir),
            resolvedPath: entry.filePath,
            ruleIndex: entry.ruleIndex,
            sourcePath: entry.filePath,
            violation: 'outside-source-boundary',
          },
          filePath: entry.filePath,
          locations: [
            { filePath: entry.filePath, label: 'allowlist file' },
            {
              filePath: options.config.configPath,
              label: 'Limina config',
              scope: `proof.allowlist[${entry.ruleIndex}]`,
            },
          ],
          presentation: {
            detailLines,
            title:
              'Typecheck proof allowlist file is outside the configured source boundary',
          },
          reason,
          scope: `proof.allowlist[${entry.ruleIndex}]`,
        }),
      );
      continue;
    }

    if (options.baseCoverageByFile.has(entry.filePath)) {
      const coverage = options.baseCoverageByFile.get(entry.filePath) ?? [];
      const detailLines = [
        'Typecheck proof allowlist file is already covered without the allowlist:',
        `  file: ${toRelativePath(options.config.rootDir, entry.filePath)}`,
      ];

      options.findings.push(
        createProofFinding({
          code: LIMINA_CHECK_ISSUE_CODES.proofAllowlistInvalid,
          evidence: [
            { label: 'diagnostic', lines: [...detailLines] },
            ...coverage.map((source) => ({
              label: 'existing coverage',
              value: source.label,
            })),
          ],
          facts: {
            configuredPath: entry.configuredPath,
            coverage: [...coverage],
            kind: 'entry-coverage',
            repositoryRoot: normalizeAbsolutePath(options.config.rootDir),
            resolvedPath: entry.filePath,
            ruleIndex: entry.ruleIndex,
            sourcePath: entry.filePath,
            violation: 'already-covered',
          },
          filePath: entry.filePath,
          locations: [
            { filePath: entry.filePath, label: 'allowlist file' },
            {
              filePath: options.config.configPath,
              label: 'Limina config',
              scope: `proof.allowlist[${entry.ruleIndex}]`,
            },
          ],
          presentation: {
            detailLines,
            title:
              'Typecheck proof allowlist file is already covered without the allowlist',
          },
          reason:
            'Proof allowlist entries must describe source files that have no checker or graph coverage.',
          scope: `proof.allowlist[${entry.ruleIndex}]`,
        }),
      );
    }
  }
}
