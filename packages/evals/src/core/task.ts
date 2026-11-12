export type Domain =
  | 'initialization'
  | 'configuration'
  | 'reference-graph'
  | 'checker'
  | 'source-governance'
  | 'workflow'
  | 'troubleshooting'
  | 'package-release'
  | 'negative-control';

export interface MutationRule {
  path: string;
  descendants?: boolean;
  operations: ('add' | 'modify' | 'delete')[];
  /**
  JSON pointers. Omitting this permits complete file contents, not execution.
  */
  jsonFields?: string[];
  allowExecutable?: boolean;
  content?: 'static-limina-config';
  /**
  Controller-authorized pipeline commands; no cwd or environment overrides.
  */
  pipelinePolicy?: {
    builtins: string[];
    commands: { command: string; argsPrefix: string[] }[];
  };
}

export interface DependencyInput {
  path: string;
  format: 'manifest' | 'json' | 'yaml';
}

export interface DependencyVariant {
  id: string;
  /**
  Semantic digest of the complete set of installation inputs.
  */
  inputsDigest: string;
  /**
  Controller-owned, admitted package closure; never supplied by an Agent.
  */
  closureDigest: string;
}

export interface TaskSpec {
  version: 2;
  bankRevision?: 'v2' | 'v2.1' | 'v2.2';
  id: string;
  split: 'dev' | 'sealed';
  domain: Domain;
  prompt: string;
  fixtureDigest: string;
  capturePolicy: {
    excludedRoots: string[];
    requiredRoots: string[];
  };
  mutationPolicy: {
    rules: MutationRule[];
    protectedRoots: string[];
  };
  dependencyPolicy: {
    inputs: DependencyInput[];
    variants: DependencyVariant[];
  };
  installPlan: {
    toolchainDigest: string;
    manager: 'pnpm';
    managerVersion: '12.10.1';
    offline: true;
    ignoreScripts: true;
    /**
    Explicit prepared commands owned by the controller, not manifest hooks.
    */
    setupSteps: { executable: string; args: string[] }[];
    /**
    Controller-created relative links inside excluded dependency directories.
    */
    projectLinks?: { path: string; target: string }[];
  };
  gradingContract: {
    graderDigest: string;
    requiredAssertions: string[];
  };
}
