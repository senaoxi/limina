import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { ActivationEvidence } from './activation.ts';
import type { UsageRecord } from './budget.ts';
import {
  type ExperimentManifest,
  type ExperimentSlot,
  verifyExperiment,
} from './experiment.ts';
import { contentIdentity } from './identity.ts';
import {
  type AttemptFacts,
  type AttemptOutcome,
  deriveOutcome,
} from './outcome.ts';
import { assertRelativePath, sha256 } from './snapshot.ts';
import type { TaskSpec } from './task.ts';

export interface EvidenceReference {
  kind:
    | 'fixture'
    | 'start'
    | 'final'
    | 'trace'
    | 'assertions'
    | 'infrastructure';
  path: string;
  sha256: string;
}
export interface AttemptRecord {
  version: 1 | 2;
  modelProfileId?: string;
  reservationId?: string;
  observedModelId?: string | null;
  replacementOf?: string | null;
  activationEvidence?: ActivationEvidence;
  runId: string;
  experimentIdentity: string;
  slot: ExperimentSlot;
  ordinal: 1 | 2;
  startedAt: string;
  completedAt: string;
  facts: AttemptFacts;
  outcome: AttemptOutcome;
  usage: UsageRecord | null;
  time: { agentMs: number | null; endToEndMs: number | null };
  activation: {
    installed: 'yes' | 'no' | 'unknown';
    discovered: 'yes' | 'no' | 'unknown';
    used: 'yes' | 'no' | 'unknown';
  };
  evidence: EvidenceReference[];
}

interface StartedAttempt {
  runId: string;
  slotId: string;
  ordinal: 1 | 2;
  startedAt: string;
}
type RunEvent =
  | { type: 'started'; attempt: StartedAttempt }
  | { type: 'finished'; record: AttemptRecord };
interface JournalEntry {
  version: 1;
  previous: string | null;
  event: RunEvent;
  digest: string;
}
interface RunState {
  starts: StartedAttempt[];
  records: AttemptRecord[];
  inFlight: StartedAttempt | null;
}

/**
Controller-owned append-only records. An unfinished attempt is never silently restarted.
*/
export class RunStore {
  static open(directory: string): RunStore {
    const bytes = readFileSync(path.join(directory, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(bytes) as ExperimentManifest;
    return new RunStore(directory, manifest, 'read');
  }

  static openAt(
    directory: string,
    prefixBytes: number,
    prefixSha256: string,
  ): RunStore {
    const store = this.open(directory);
    const file = path.join(directory, 'attempts.jsonl');
    const bytes = existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
    if (
      !Number.isSafeInteger(prefixBytes) ||
      prefixBytes < 0 ||
      bytes.length < prefixBytes ||
      sha256(bytes.subarray(0, prefixBytes)) !== prefixSha256
    )
      throw new Error('Attempt journal prefix changed');
    store.#journalSnapshot = bytes.subarray(0, prefixBytes).toString('utf8');
    return store;
  }
  #journalSnapshot: string | undefined;
  readonly #readOnly: boolean;
  readonly directory: string;
  readonly manifest: ExperimentManifest;

  constructor(
    directory: string,
    manifest: ExperimentManifest,
    mode: 'write' | 'read' = 'write',
  ) {
    this.#readOnly = mode === 'read';
    verifyExperiment(manifest);
    if (!path.isAbsolute(directory))
      throw new Error('Run storage requires an absolute controller path');
    if (!this.#readOnly) mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (realpathSync(directory) !== directory)
      throw new Error('Run storage must not be a symlink alias');
    this.directory = directory;
    this.manifest = structuredClone(manifest);
    const file = path.join(directory, 'manifest.json');
    if (this.#readOnly) {
      if (
        realpathSync(file) !== file ||
        contentIdentity(JSON.parse(readFileSync(file, 'utf8'))) !==
          contentIdentity(manifest)
      )
        throw new Error('Read-only experiment changed');
      return;
    }
    try {
      writeFileSync(file, `${JSON.stringify(manifest)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (
        contentIdentity(JSON.parse(readFileSync(file, 'utf8'))) !==
        contentIdentity(manifest)
      )
        throw new Error('Cannot resume a different frozen experiment', {
          cause: error,
        });
    }
  }

  #entries(): JournalEntry[] {
    verifyExperiment(this.manifest);
    const saved = readFileSync(
      path.join(this.directory, 'manifest.json'),
      'utf8',
    );
    if (contentIdentity(JSON.parse(saved)) !== contentIdentity(this.manifest))
      throw new Error('Frozen experiment changed on disk');
    const file = path.join(this.directory, 'attempts.jsonl');
    if (this.#journalSnapshot === undefined && !existsSync(file)) return [];
    const raw = this.#journalSnapshot ?? readFileSync(file, 'utf8');
    if (raw && !raw.endsWith('\n'))
      throw new Error('Incomplete attempt journal');
    let previous: string | null = null;
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const entry = JSON.parse(line) as JournalEntry;
        if (
          entry.version !== 1 ||
          entry.previous !== previous ||
          entry.digest !==
            contentIdentity({
              version: entry.version,
              previous: entry.previous,
              event: entry.event,
            })
        )
          throw new Error('Attempt journal identity mismatch');
        previous = entry.digest;
        return entry;
      });
  }

  #state(entries: JournalEntry[]): RunState {
    const state: RunState = { starts: [], records: [], inFlight: null };
    for (const { event } of entries) {
      if (event.type === 'started') {
        const attempt = event.attempt;
        if (
          state.inFlight ||
          state.starts.some((start) => start.runId === attempt.runId) ||
          this.manifest.slots.every((slot) => slot.id !== attempt.slotId)
        )
          throw new Error('Invalid or concurrent attempt start');
        state.starts.push(attempt);
        state.inFlight = attempt;
      } else if (event.type === 'finished') {
        const record = event.record;
        const slot = this.manifest.slots.find(
          (candidate) => candidate.id === record.slot.id,
        );
        if (
          !state.inFlight ||
          record.runId !== state.inFlight.runId ||
          record.ordinal !== state.inFlight.ordinal ||
          record.experimentIdentity !== this.manifest.identity ||
          contentIdentity(slot) !== contentIdentity(record.slot)
        )
          throw new Error(
            'Attempt result belongs to a different slot or identity',
          );
        state.records.push(record);
        state.inFlight = null;
      } else throw new Error('Unknown attempt journal event');
    }
    return state;
  }

  #append(event: RunEvent, entries: JournalEntry[]): void {
    const value = {
      version: 1 as const,
      previous: entries.at(-1)?.digest ?? null,
      event,
    };
    const entry = { ...value, digest: contentIdentity(value) };
    const file = path.join(this.directory, 'attempts.jsonl');
    const descriptor = openSync(file, 'a', 0o600);
    try {
      appendFileSync(descriptor, `${JSON.stringify(entry)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  #locked<T>(action: () => T): T {
    if (this.#readOnly) throw new Error('Read-only run store cannot dispatch');
    const lock = path.join(this.directory, '.dispatch-lock');
    mkdirSync(lock, { mode: 0o700 });
    try {
      return action();
    } finally {
      rmSync(lock, { recursive: true });
    }
  }

  #canRetry(record: AttemptRecord): boolean {
    const execution = record.facts.execution;
    return (
      record.ordinal === 1 &&
      this.#hasEvidence(record) &&
      record.outcome.status === 'infra_error' &&
      execution.status === 'infra_error' &&
      record.evidence.some(
        (reference) =>
          reference.kind === 'infrastructure' &&
          reference.sha256 === execution.evidence.recordId,
      )
    );
  }

  #hasEvidence(record: AttemptRecord): boolean {
    if (record.evidence.length === 0) return false;
    try {
      for (const reference of record.evidence) {
        assertRelativePath(reference.path);
        const file = path.join(this.directory, reference.path);
        if (
          realpathSync(file) !== file ||
          sha256(readFileSync(file)) !== reference.sha256
        )
          return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  next(): { slot: ExperimentSlot; ordinal: 1 | 2 } | null {
    const state = this.#state(this.#entries());
    if (state.inFlight)
      throw new Error(
        'Unfinished attempt requires evidence reconciliation; automatic restart is forbidden',
      );
    for (const slot of this.manifest.slots) {
      const records = state.records.filter(
        (record) => record.slot.id === slot.id,
      );
      if (records.length === 0) return { slot, ordinal: 1 };
      if (records.length === 1 && this.#canRetry(records[0]!))
        return { slot, ordinal: 2 };
    }
    return null;
  }

  startNext(expected?: {
    slotId: string;
    ordinal: number;
  }): StartedAttempt | null {
    return this.#locked(() => {
      const next = this.next();
      if (!next) return null;
      if (
        expected &&
        (expected.slotId !== next.slot.id || expected.ordinal !== next.ordinal)
      )
        throw new Error('Frozen slot claim changed');
      const attempt = {
        runId: `${next.slot.id}-${next.ordinal}`,
        slotId: next.slot.id,
        ordinal: next.ordinal,
        startedAt: new Date().toISOString(),
      };
      this.#append({ type: 'started', attempt }, this.#entries());
      return attempt;
    });
  }

  finish(
    runId: string,
    task: TaskSpec,
    data: Pick<
      AttemptRecord,
      'facts' | 'usage' | 'time' | 'activation' | 'evidence'
    > & { activationEvidence?: ActivationEvidence },
  ): AttemptRecord {
    return this.#locked(() => {
      const entries = this.#entries();
      const start = this.#state(entries).inFlight;
      if (!start || start.runId !== runId)
        throw new Error('Attempt was not started or is already finished');
      const slot = this.manifest.slots.find(
        (candidate) => candidate.id === start.slotId,
      )!;
      const frozenTask = this.manifest.inputs.tasks.find(
        (candidate) => candidate.id === task.id,
      );
      if (
        slot.taskId !== task.id ||
        frozenTask?.specDigest !== contentIdentity(task)
      )
        throw new Error('Task identity changed during execution');
      for (const reference of data.evidence) {
        assertRelativePath(reference.path);
        const file = path.join(this.directory, reference.path);
        if (
          realpathSync(file) !== file ||
          sha256(readFileSync(file)) !== reference.sha256
        )
          throw new Error(
            'Attempt evidence changed or escaped control storage',
          );
      }
      const execution = data.facts.execution;
      if (
        execution.status === 'infra_error' &&
        data.evidence.every(
          (reference) =>
            reference.kind !== 'infrastructure' ||
            reference.sha256 !== execution.evidence.recordId,
        )
      )
        throw new Error(
          'Infrastructure classification requires captured evidence',
        );
      for (const value of Object.values(data.time))
        if (value !== null && (!Number.isFinite(value) || value < 0))
          throw new Error('Invalid attempt duration');
      const record: AttemptRecord = {
        ...structuredClone(data),
        version: this.manifest.version,
        ...(this.manifest.inputs.modelProfile && {
          modelProfileId: this.manifest.inputs.modelProfile.id,
          reservationId: runId,
          replacementOf: start.ordinal === 2 ? `${slot.id}-1` : null,
          observedModelId: null,
        }),
        runId,
        experimentIdentity: this.manifest.identity,
        slot: structuredClone(slot),
        ordinal: start.ordinal,
        startedAt: start.startedAt,
        completedAt: new Date().toISOString(),
        outcome: deriveOutcome(task, data.facts),
      };
      if (this.manifest.version === 2) {
        const reference = data.evidence.find((entry) => entry.kind === 'trace');
        if (reference) {
          const trace = JSON.parse(
            readFileSync(path.join(this.directory, reference.path), 'utf8'),
          ) as {
            evidence: {
              status: string;
              modelProfileId?: string;
              observedModelIds?: string[];
            };
          };
          if (
            trace.evidence.status === 'complete' &&
            trace.evidence.modelProfileId === record.modelProfileId &&
            trace.evidence.observedModelIds?.length === 1 &&
            trace.evidence.observedModelIds[0] === this.manifest.policy.model
          )
            record.observedModelId = trace.evidence.observedModelIds[0];
        }
        if (record.outcome.status === 'passed' && !record.observedModelId)
          throw new Error(
            'Passing V2 attempt requires matching model evidence',
          );
      }
      if (
        record.outcome.status === 'passed' &&
        ['fixture', 'start', 'final', 'trace', 'assertions'].some(
          (kind) =>
            data.evidence.filter((reference) => reference.kind === kind)
              .length !== 1,
        )
      )
        throw new Error(
          'Passing attempts require complete state, trace and assertion artifacts',
        );
      this.#append({ type: 'finished', record }, entries);
      return record;
    });
  }

  summary() {
    const state = this.#state(this.#entries());
    return {
      experimentIdentity: this.manifest.identity,
      attempts: state.records,
      attemptEvidence: state.records.map((record) => ({
        runId: record.runId,
        status: this.#hasEvidence(record)
          ? ('complete' as const)
          : ('unknown' as const),
      })),
      inFlight: state.inFlight,
      slots: this.manifest.slots.map((slot) => {
        const attempts = state.records.filter(
          (record) => record.slot.id === slot.id,
        );
        const selected = attempts.at(-1) ?? null;
        const evidenceStatus =
          selected && this.#hasEvidence(selected)
            ? ('complete' as const)
            : ('unknown' as const);
        return {
          slot,
          selected,
          evidenceStatus,
          status:
            state.inFlight?.slotId === slot.id
              ? ('in_flight' as const)
              : (evidenceStatus === 'unknown' &&
                    selected?.outcome.status === 'passed') ||
                  (selected !== null &&
                    this.manifest.version === 2 &&
                    selected.outcome.isValidAttempt &&
                    selected.observedModelId !== this.manifest.policy.model)
                ? ('unknown' as const)
                : (selected?.outcome.status ?? ('not_run' as const)),
        };
      }),
    };
  }
}
