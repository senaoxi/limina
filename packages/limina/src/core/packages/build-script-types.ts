import type { BuildCheckerPreset } from '#config/runner';

export interface PackageBuildScript {
  checker?: BuildCheckerPreset;
  command: string;
  configPath: string;
  name: string;
  packageJsonPath: string;
  packageName: string;
  raw: boolean;
}

export interface PackageBuildScriptDiagnostic {
  command: string;
  packageJsonPath: string;
  packageName: string;
  reason: string;
  scriptName: string;
}

export interface PackageBuildScriptCollection {
  diagnostics: PackageBuildScriptDiagnostic[];
  scripts: PackageBuildScript[];
}

export interface PackageBuildScriptSource {
  command: string;
  packageDirectory: string;
  packageJsonPath: string;
  packageName: string;
  scriptName: string;
}
