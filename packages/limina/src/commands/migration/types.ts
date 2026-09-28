import type { JsonObject } from '#core/tsconfig/actions';
import type ts from 'typescript';
import type { LiminaFlowReporter } from '../../flow';
import type { PreflightCapableOptions } from '../../preflight';
import type { MigrationCleanupWarning } from './transaction';

export interface RunMigrationOptions extends PreflightCapableOptions {
  configLoader?: 'native' | 'tsx';
  mode?: string;
  confirmDirtyWorkspace?: (message: string) => Promise<boolean>;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  selectHardlinkStrategy?: (
    message: string,
  ) => Promise<HardlinkMigrationDecision>;
}

export type HardlinkMigrationDecision = 'cancel' | 'rewrite' | 'skip';

export interface RunMigrationResult {
  processingComplete: boolean;
  inputConsumable: boolean;
  incompleteFiles: string[];
  reportPath?: string;
  reportWarning?: string;
  checkerEntryCount: number;
  hardlinkRewrittenFiles: string[];
  hardlinkSkippedFiles: string[];
  modifiedFiles: string[];
  recursiveReferenceCount: number;
  rootDir: string;
  skippedFiles: string[];
}

export interface MigrationEffectiveConfig {
  fileNames: string[];
  options: ts.CompilerOptions;
}

export interface MigrationTarget {
  configObject: JsonObject;
  configPath: string;
  effectiveConfig: MigrationEffectiveConfig;
  isLiminaSolution: boolean;
  isTypeScriptSolution: boolean;
  originalBytes: Buffer;
  originalContent: string;
}

export interface RunMigrationImplResult {
  cleanupWarnings: MigrationCleanupWarning[];
  result: RunMigrationResult;
}
