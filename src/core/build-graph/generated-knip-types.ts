export type GeneratedKnipPackageBuildMode = 'managed' | 'raw';

export interface GeneratedKnipPackageBuildScript {
  checker?: 'tsc' | 'vue-tsc' | 'tsgo';
  command: string;
  configPath: string;
  mode: GeneratedKnipPackageBuildMode;
  name: string;
}

export interface GeneratedKnipPackageConfig {
  configPath: string;
  packageDirectory: string;
  packageJsonPath: string;
  packageName: string | null;
  references: string[];
  scripts: GeneratedKnipPackageBuildScript[];
}

export interface GeneratedKnipPackageDiagnostic {
  command?: string;
  packageJsonPath: string;
  packageName: string | null;
  reason: string;
  scriptName?: string;
}

export interface PreparedGeneratedKnipPackageConfig {
  config: GeneratedKnipPackageConfig;
  configPath: string;
  content: {
    files: [];
    references: { path: string }[];
  };
}

export interface PreparedGeneratedKnipPackageConfigs {
  configs: PreparedGeneratedKnipPackageConfig[];
  diagnostics: GeneratedKnipPackageDiagnostic[];
}
