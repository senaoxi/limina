import type {
  MutationAuthority,
  MutationBoundarySnapshot,
} from '../../utils/mutation-boundary';

export interface FileState {
  readonly content: Buffer;
  readonly dev: string;
  readonly hash: string;
  readonly ino: string;
  readonly length: number;
  readonly mode: number;
  readonly nlink: number;
}

export interface InitFileMutationPlan {
  readonly authority: MutationAuthority;
  readonly snapshot: MutationBoundarySnapshot;
  readonly targetPath: string;
  readonly tempAuthority: MutationAuthority;
  readonly tempPath: string;
  readonly tempSnapshot: MutationBoundarySnapshot;
}

export interface InitMutationContext {
  readonly filePlans: ReadonlyMap<string, InitFileMutationPlan>;
  readonly generatedRootAuthority: MutationAuthority;
  readonly generatedRootPath: string;
}
