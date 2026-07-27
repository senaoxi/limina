import type { LiminaFlowReporter } from '../../flow';
import type { InitMutationContext } from './mutation';

export interface RunInitOptions {
  clearScreen?: boolean;
  cwd?: string;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  yes?: boolean;
}

export interface RunInitResult {
  buildCommand: string;
  installRequired: boolean;
  removedPaths: string[];
  rootDir: string;
  skippedFiles: string[];
  skillInstallStatus: InitSkillInstallStatus;
  workspacePackageCount: number;
  writtenFiles: string[];
}

export type InitSkillInstallStatus = 'failed' | 'installed' | 'skipped';
export type InitFlowStepStatus = 'pass' | 'skip';

export interface InitPromptOptions {
  yes?: boolean;
}

export interface InitFlowStepResult<T> {
  message: string;
  status: InitFlowStepStatus;
  value: T;
}

export interface InitFileStepResult {
  message: string;
  status: InitFlowStepStatus;
}

export interface LiminaPackageMetadata {
  typescriptRange: string;
  versionRange: string;
}

export interface RootPackageJsonUpdateResult extends InitFileStepResult {
  installRequired: boolean;
}

export interface InitSkillInstallResult {
  flowStatus: InitFlowStepStatus;
  message: string;
  status: InitSkillInstallStatus;
}

export interface InitFileState {
  mutationContext: InitMutationContext;
  removedPaths: string[];
  skippedFiles: string[];
  writtenFiles: string[];
}
