import { ProofLogger } from '../logger';
import type { CoverageSource } from './coverage';
import type { RunProofCheckImplOptions } from './runner-types';

interface ProofStateSummary {
  config: {
    proof?: { allowlist?: { file: string }[] };
  };
  dtsConfigPaths: string[];
  entryProjectPaths: string[];
  options: RunProofCheckImplOptions;
}

interface ProofSuccessOptions {
  coverageByFile: Map<string, CoverageSource[]>;
  sourceFiles: Set<string>;
  state: ProofStateSummary;
}

function countCoverageType(
  coverageByFile: Map<string, CoverageSource[]>,
  type: CoverageSource['type'],
): number {
  return [...coverageByFile.values()].filter((sources) =>
    sources.some((source) => source.type === type),
  ).length;
}

function formatSuccess(options: ProofSuccessOptions): string {
  const graphCount = countCoverageType(options.coverageByFile, 'graph');
  const checkerCount = countCoverageType(options.coverageByFile, 'checker');

  return [
    `Checked ${options.state.entryProjectPaths.length} checker entry projects and ${options.state.dtsConfigPaths.length} dts configs.`,
    `Graph-capable checker entries cover ${graphCount} files; checker entries cover ${checkerCount} files.`,
    `Configured source boundary covers ${options.sourceFiles.size} files.`,
  ].join('\n');
}

function getAllowlist(state: ProofStateSummary): { file: string }[] {
  return state.config.proof?.allowlist ?? [];
}

function logAllowlist(allowlist: { file: string }[]): void {
  if (allowlist.length === 0) {
    return;
  }

  ProofLogger.info(
    `Explicit typecheck proof allowlist: ${allowlist
      .map((entry) => entry.file)
      .join(', ')}`,
  );
}

export function logProofSuccess(options: ProofSuccessOptions): void {
  if (options.state.options.logSuccess === false) {
    return;
  }

  ProofLogger.success(formatSuccess(options));
  logAllowlist(getAllowlist(options.state));
}
