import type ts from 'typescript';
import type {
  NativeCompletenessPartition,
  NativeEvidenceFailure,
} from '../../domain/analysis/native-evidence';
import type { NativeProgramFrontier } from './native-program-frontier';

export function nativeEntryPartitions(input: {
  contextId: string;
  program: ts.Program;
  frontier: NativeProgramFrontier;
  failures: readonly NativeEvidenceFailure[];
}): NativeCompletenessPartition[] {
  const roots: NativeCompletenessPartition[] = input.program
    .getRootFileNames()
    .filter((file) => input.program.getSourceFile(file) !== undefined)
    .map((file) => ({
      contextId: input.contextId,
      entryId: file,
      channel: 'implicit',
      state: 'observed',
      evidenceIds: [file],
    }));
  return [
    ...roots,
    ...input.program
      .getRootFileNames()
      .flatMap((file) => stoppedRootPartition(input, file)),
    ...input.failures.flatMap((failure) =>
      failurePartitions(input.contextId, failure),
    ),
  ];
}

export function failurePartitions(
  contextId: string,
  failure: NativeEvidenceFailure,
): NativeCompletenessPartition[] {
  const entries =
    failure.affected.kind === 'entries'
      ? failure.affected.entryIds
      : [contextId];
  return entries.map((entryId) => ({
    contextId,
    entryId,
    channel: 'implicit',
    state: 'gap',
    failureId: failure.id,
    cause: failureCause(failure),
    evidenceIds: failure.evidenceIds,
  }));
}

function failureCause(failure: NativeEvidenceFailure) {
  if (failure.kind === 'input-drift') return 'input-drift' as const;
  return failure.kind === 'internal'
    ? ('internal-failure' as const)
    : ('unavailable' as const);
}

function stoppedRootPartition(
  input: Parameters<typeof nativeEntryPartitions>[0],
  file: string,
): NativeCompletenessPartition[] {
  const attempt = input.frontier.inspect(file);
  if (attempt.file.physical.state !== 'verified') return [];
  return attempt.decision.action === 'stop'
    ? rootStop(input.contextId, file, attempt.decision.reason)
    : [];
}
function rootStop(
  contextId: string,
  entryId: string,
  reason:
    | Extract<
        NativeCompletenessPartition,
        { state: 'proven-stop' }
      >['stopReason']
    | 'input-drift'
    | 'unsupported-observation',
): NativeCompletenessPartition[] {
  if (reason === 'input-drift' || reason === 'unsupported-observation')
    return [];
  return [
    {
      contextId,
      entryId,
      channel: 'implicit',
      state: 'proven-stop',
      stopReason: reason,
      evidenceIds: [entryId],
    },
  ];
}
