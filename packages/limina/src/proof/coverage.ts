export type CoverageSource =
  | {
      configuredPath: string;
      label: string;
      reason: string;
      resolvedPath: string;
      ruleIndex: number;
      type: 'allowlist';
    }
  | {
      checkerEntryPath: string;
      checkerName: string;
      label: string;
      projectPath: string;
      type: 'checker';
    }
  | {
      checkerEntryPath: string;
      checkerName: string;
      checkerPreset: string;
      label: string;
      projectPath: string;
      type: 'graph';
    };

export function addCoverage(
  coverageByFile: Map<string, CoverageSource[]>,
  filePath: string,
  source: CoverageSource,
): void {
  const sources = coverageByFile.get(filePath) ?? [];

  sources.push(source);
  coverageByFile.set(filePath, sources);
}

export function cloneCoverageByFile(
  coverageByFile: Map<string, CoverageSource[]>,
): Map<string, CoverageSource[]> {
  return new Map(
    [...coverageByFile.entries()].map(([filePath, sources]) => [
      filePath,
      [...sources],
    ]),
  );
}
