import type { SourceConfigCoverageIndex } from '../../domain/analysis/native-coverage';
import {
  NATIVE_EVIDENCE_VERSION,
  type NativeCompletenessPartition,
  type NativeEvidenceFailure,
  type NativeEvidenceSnapshot,
  type NativeResolution,
} from '../../domain/analysis/native-evidence';
import type { NativeCompilationObligation } from '../../domain/analysis/native-obligation';
import type { NativeObservedProgram } from './native-program-api';
import type {
  NativeProgramFrontier,
  NativeSourceAttempt,
} from './native-program-frontier';
import {
  nativeCoverageFailures,
  nativeEntryPartitions,
} from './native-program-partitions';
import {
  nativeProjectRelations,
  nativeTraversalLinks,
} from './native-program-relations';
import type { NativeRequestResult } from './native-program-request-data';
import type { NativeProgramRequests } from './native-program-requests';
import { remainingNativeObligations } from './native-request-obligations';

function attemptedLoad(
  attempt: NativeSourceAttempt | undefined,
): NativeResolution['compilerLoad'] {
  return attempt === undefined ? 'not-observed' : 'attempted';
}

function resolutionLoad(
  resolution: NativeResolution,
  program: NativeObservedProgram,
  attempt: NativeSourceAttempt | undefined,
): NativeResolution {
  if (resolution.target === null) return resolution;
  const source = program.getSourceFile(resolution.target.lexicalPath);
  return {
    ...resolution,
    compilerLoad: source === undefined ? attemptedLoad(attempt) : 'loaded',
  };
}

function targetAttempt(
  resolution: NativeResolution,
  attempts: ReadonlyMap<string, NativeSourceAttempt>,
) {
  return resolution.target === null
    ? undefined
    : attempts.get(resolution.target.lexicalPath);
}

function partition(
  entry: NativeRequestResult,
  attempt: NativeSourceAttempt | undefined,
): NativeCompletenessPartition {
  const base = {
    contextId: entry.request.consumerContextId,
    entryId: entry.request.id,
    channel: entry.request.channel,
    evidenceIds: [entry.request.id],
  };
  if (entry.resolution.state === 'unavailable')
    return {
      ...base,
      state: 'proven-stop',
      stopReason: unavailableStop(entry),
    };
  return entry.resolution.state === 'unresolved'
    ? { ...base, state: 'proven-stop', stopReason: 'unresolved' }
    : attemptedPartition(base, attempt);
}

function attemptedPartition(
  base: Pick<
    NativeCompletenessPartition,
    'contextId' | 'entryId' | 'channel' | 'evidenceIds'
  >,
  attempt: NativeSourceAttempt | undefined,
): NativeCompletenessPartition {
  return attempt?.decision.action === 'stop'
    ? stoppedPartition(base, attempt.decision.reason)
    : { ...base, state: 'observed' };
}

function stoppedPartition(
  base: Pick<
    NativeCompletenessPartition,
    'contextId' | 'entryId' | 'channel' | 'evidenceIds'
  >,
  reason: Extract<
    NativeSourceAttempt['decision'],
    { action: 'stop' }
  >['reason'],
): NativeCompletenessPartition {
  if (reason === 'input-drift' || reason === 'unsupported-observation')
    throw new Error(`Invalid completed frontier: ${reason}`);
  return { ...base, state: 'proven-stop', stopReason: reason };
}

export function createNativeProgramSnapshot(options: {
  program: NativeObservedProgram;
  frontier: NativeProgramFrontier;
  coverage: SourceConfigCoverageIndex;
  requests: NativeProgramRequests;
  failures: readonly NativeEvidenceFailure[];
  obligations: readonly NativeCompilationObligation[];
}): NativeEvidenceSnapshot {
  const { requests, frontier, program } = options;
  const attempts = new Map(
    frontier.attempts.map((attempt) => [attempt.file.lexicalPath, attempt]),
  );
  const entries = requests.entries;
  const obligations = [
    ...options.obligations,
    ...remainingNativeObligations(entries, options.obligations),
  ];
  const failures = [
    ...options.failures,
    ...nativeCoverageFailures(options.coverage),
  ];
  const coverage = observedCoverage(frontier, entries);
  return {
    version: NATIVE_EVIDENCE_VERSION,
    run: failures.length === 0 ? 'completed' : 'unavailable',
    contexts: [requests.context],
    coverageIndexes: [options.coverage],
    coverage: coverage.values().toArray(),
    requests: entries.map((entry) => entry.request),
    traversal: nativeTraversalLinks({
      entries,
      roots: program.getRootFileNames(),
    }),
    resolutions: entries.map(({ resolution }) =>
      resolutionLoad(resolution, program, targetAttempt(resolution, attempts)),
    ),
    relations: nativeProjectRelations({
      entries,
      frontier,
      obligations,
      program,
      context: requests.context,
    }),
    obligations,
    completeness: [
      ...nativeEntryPartitions({
        contextId: requests.context.id,
        frontier,
        program,
        failures,
      }),
      ...entries.map((entry) =>
        partition(entry, targetAttempt(entry.resolution, attempts)),
      ),
    ],
    failures,
  };
}

function observedCoverage(
  frontier: NativeProgramFrontier,
  entries: readonly NativeRequestResult[],
) {
  const coverage = new Map(
    frontier.attempts.map((attempt) => [
      attempt.file.lexicalPath,
      attempt.coverage,
    ]),
  );
  for (const { resolution } of entries) {
    if (resolution.target === null) continue;
    const file = resolution.target.lexicalPath;
    coverage.set(file, frontier.inspect(file).coverage);
  }
  return coverage;
}

function unavailableStop(
  entry: NativeRequestResult,
): 'resolution-disabled' | 'observation-unavailable' {
  return entry.resolution.pathSelection?.state === 'disabled'
    ? 'resolution-disabled'
    : 'observation-unavailable';
}
