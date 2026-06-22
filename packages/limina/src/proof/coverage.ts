export interface CoverageSource {
  label: string;
  type: 'allowlist' | 'checker' | 'graph';
}

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
