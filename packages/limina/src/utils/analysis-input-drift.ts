export class AnalysisInputDriftError extends Error {
  override readonly name = 'AnalysisInputDriftError';
  readonly inputPath: string;
  constructor(inputPath: string) {
    super(`Analysis input changed during analysis: ${inputPath}`);
    this.inputPath = inputPath;
  }
}
