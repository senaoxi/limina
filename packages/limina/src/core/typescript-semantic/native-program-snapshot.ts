import type ts from 'typescript';
import type { NativeEvidenceContext } from '../../domain/analysis/native-context';
import type { NativeCoverage } from '../../domain/analysis/native-coverage';
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
import { nativeEntryPartitions } from './native-program-partitions';
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

export function nativeRequestPartition(
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
  requests: NativeProgramRequests;
  failures: readonly NativeEvidenceFailure[];
  obligations: readonly NativeCompilationObligation[];
}): NativeEvidenceSnapshot {
  const { requests, frontier, program, failures } = options;
  const attempts = new Map(
    frontier.attempts.map((attempt) => [attempt.file.lexicalPath, attempt]),
  );
  const entries = requests.entries;
  const obligations = [
    ...options.obligations,
    ...remainingNativeObligations(
      entries,
      options.obligations,
      program.getCompilerOptions(),
      frontier,
    ),
  ];
  const coverage = observedCoverage(frontier, entries);
  return assembleNativeSnapshot({
    context: requests.context,
    frontier,
    coverage: coverage.values().toArray(),
    entries: entries.map((entry) => ({
      ...entry,
      resolution: resolutionLoad(
        entry.resolution,
        program,
        targetAttempt(entry.resolution, attempts),
      ),
    })),
    projectReferences: program.getProjectReferences() ?? [],
    roots: program.getRootFileNames(),
    obligations,
    completeness: [
      ...nativeEntryPartitions({
        contextId: requests.context.id,
        frontier,
        program,
        failures,
      }),
      ...entries.map((entry) =>
        nativeRequestPartition(
          entry,
          targetAttempt(entry.resolution, attempts),
        ),
      ),
    ],
    failures,
  });
}

export function assembleNativeSnapshot(options: {
  context: NativeEvidenceContext;
  frontier: NativeProgramFrontier;
  coverage: NativeEvidenceSnapshot['coverage'];
  entries: readonly NativeRequestResult[];
  projectReferences: readonly ts.ProjectReference[];
  roots: readonly string[];
  completeness: NativeEvidenceSnapshot['completeness'];
  failures: NativeEvidenceSnapshot['failures'];
  obligations: NativeEvidenceSnapshot['obligations'];
}): NativeEvidenceSnapshot {
  const { context, entries, frontier, failures, obligations } = options;
  return {
    version: NATIVE_EVIDENCE_VERSION,
    run: failures.length === 0 ? 'completed' : 'unavailable',
    contexts: [context],
    coverageIndexes: [frontier.index],
    coverage: options.coverage,
    requests: entries.map((entry) => entry.request),
    traversal: nativeTraversalLinks({
      entries,
      roots: options.roots,
      fileKey: frontier.fileKey,
    }),
    resolutions: entries.map((entry) => entry.resolution),
    relations: nativeProjectRelations({
      context,
      entries,
      frontier,
      obligations,
      projectReferences: options.projectReferences,
    }),
    obligations,
    completeness: options.completeness,
    failures,
  };
}

export function observedCoverage(
  frontier: NativeProgramFrontier,
  entries: readonly NativeRequestResult[],
): Map<string, NativeCoverage> {
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
