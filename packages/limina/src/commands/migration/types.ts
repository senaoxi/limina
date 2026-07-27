import type { JsonObject } from '#core/tsconfig/actions';
import type { LiminaFlowReporter } from '../../flow';
import type { PreflightCapableOptions } from '../../preflight';
import type { MigrationCleanupWarning } from './transaction';

export interface RunMigrationOptions extends PreflightCapableOptions {
  flow?: LiminaFlowReporter;
  flowDepth?: number;
}

export interface RunMigrationResult {
  checkerEntryCount: number;
  modifiedFiles: string[];
  recursiveReferenceCount: number;
  rootDir: string;
  skippedFiles: string[];
}

export interface MigrationEntry {
  configPath: string;
}

export interface MigrationEntryCollection {
  activeCheckerCount: number;
  candidateEntryCount: number;
  entries: MigrationEntry[];
  excludePatterns: string[];
  includePatterns: string[];
  mode: 'auto' | 'explicit';
}

export interface MigrationTarget {
  configObject: JsonObject;
  configPath: string;
  isSolutionStyle: boolean;
  originalBytes: Buffer;
  originalContent: string;
}

export interface MigrationTargetCollection {
  checkerEntryCount: number;
  recursiveReferenceCount: number;
  targets: MigrationTarget[];
}

export interface RunMigrationImplResult {
  cleanupWarnings: MigrationCleanupWarning[];
  result: RunMigrationResult;
}
