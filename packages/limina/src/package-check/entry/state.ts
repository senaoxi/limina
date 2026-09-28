import type {
  PackageToolCheckResult,
  PackedPackageTarball,
} from '../runner-types';

export interface EntryExecutionState {
  checkedToolCount: number;
  packedDist?: PackedPackageTarball;
  passed: boolean;
  skippedToolCount: number;
}

export function createEntryExecutionState(): EntryExecutionState {
  return {
    checkedToolCount: 0,
    passed: true,
    skippedToolCount: 0,
  };
}

export function applyToolResult(
  state: EntryExecutionState,
  result: PackageToolCheckResult,
): void {
  if (result === 'skipped') {
    state.skippedToolCount += 1;
    return;
  }
  state.checkedToolCount += 1;
  if (result === 'failed') state.passed = false;
}

export function requireTarball(state: EntryExecutionState): Buffer {
  const packedDist = state.packedDist;
  if (packedDist === undefined) {
    throw new Error('Package tool requires a packed tarball.');
  }
  return packedDist.tarball;
}
