import type {
  MutationAuthority,
  MutationBoundaryTarget,
} from '#utils/mutation-boundary';

export interface OutputDeclarationCopyPlanEntry {
  authority?: MutationAuthority;
  outDir: string;
  rootDir: string;
  sourcePath: string;
  targetPath: string;
}

export type OutputDeclarationCopyProblemReason =
  | 'outside-root'
  | 'target-conflict'
  | 'target-is-out-dir'
  | 'target-outside-out-dir';

export interface OutputDeclarationCopyProblem {
  filePath: string;
  outDir: string;
  reason: OutputDeclarationCopyProblemReason;
  rootDir: string;
  severity: 'error' | 'warning';
  targetPath?: string;
}

export interface OutputDeclarationCopyPlan {
  entries: OutputDeclarationCopyPlanEntry[];
  problems: OutputDeclarationCopyProblem[];
}

export interface OutputDeclarationCopyOptions {
  /** Transaction-race injection used only by focused source-level tests. */
  beforePublishForTesting?: (
    entry: Readonly<OutputDeclarationCopyPlanEntry>,
    index: number,
  ) => Promise<void> | void;
  projectRootDir: string;
  requireAuthenticatedAuthorities?: boolean;
}

export class OutputDeclarationCopyError extends Error {
  readonly problems: OutputDeclarationCopyProblem[];

  constructor(message: string, problems: OutputDeclarationCopyProblem[]) {
    super(message);
    this.name = 'OutputDeclarationCopyError';
    this.problems = problems;
  }
}

export interface RegularFileState {
  readonly content: Buffer;
  readonly dev: string;
  readonly hash: string;
  readonly ino: string;
  readonly length: number;
  readonly mode: number;
  readonly nlink: number;
}

export interface OwnedDeclarationFile {
  readonly authority: MutationAuthority;
  readonly path: string;
  readonly state: RegularFileState;
  readonly transactionToken: string;
}

export interface OwnedDeclarationDirectory {
  readonly dev: string;
  readonly ino: string;
  readonly path: string;
  readonly transactionToken: string;
}

export interface PreparedDeclarationEntry {
  readonly authority: MutationAuthority;
  readonly entry: OutputDeclarationCopyPlanEntry;
  readonly sourceState: RegularFileState;
  readonly targetState?: RegularFileState;
}

export interface PreparedDeclarationCollection {
  boundaryTargets: MutationBoundaryTarget[];
  entries: PreparedDeclarationEntry[];
  problems: OutputDeclarationCopyProblem[];
}
