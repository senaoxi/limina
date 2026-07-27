import type { ResolvedLiminaConfig } from '#config/runner';
import { collectAllowlistConfigEntries } from './allowlist-config';
import { collectAllowlistFindings } from './allowlist-findings';
import type {
  AllowlistEntry,
  AllowlistEntryCollection,
} from './allowlist-types';
import { addCoverage, type CoverageSource } from './coverage';
import type { ProofFinding } from './findings';

export type {
  AllowlistEntry,
  AllowlistEntryCollection,
} from './allowlist-types';

export function collectConfiguredAllowlistEntries(
  config: ResolvedLiminaConfig,
): AllowlistEntryCollection {
  return collectAllowlistConfigEntries(config);
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
  options.findings.push(
    ...collectAllowlistFindings({
      allowlistEntries: options.allowlistEntries,
      baseCoverageByFile: options.baseCoverageByFile,
      config: options.config,
      sourceFiles: options.sourceFiles,
    }),
  );
}
