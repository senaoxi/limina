export interface ImplicitRef {
  path: string;
  reason: string;
  targetConfigPath: string;
}

export interface OutputOptions {
  declarationMap: boolean;
  outDir: string;
  rootDir: string;
  target: string;
}

export interface OutputOptionsProblem {
  readonly detailLines: readonly string[];
  readonly field: string;
  readonly reason: string;
  readonly sourceConfigPath: string;
  readonly value?: unknown;
}

export interface ConfigReaderProblemContext {
  diagnostics?: OutputOptionsProblem[];
  problems: string[];
}
