import type { CoverageSource } from './coverage';
import type { ProofFinding } from './findings';

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

export interface AllowlistFindingContext {
  baseCoverageByFile: ReadonlyMap<string, readonly CoverageSource[]>;
  repositoryRoot: string;
  sourceFiles: ReadonlySet<string>;
}
