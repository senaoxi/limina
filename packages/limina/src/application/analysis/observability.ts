import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  ProfileInventory,
  type ProviderRecord,
} from './observability-inventory';
import {
  intervalUnionUs,
  isSemanticFactLayer,
  summarizeProfile,
} from './observability-summary';
import type {
  CacheFact,
  ContextRecord,
  DecisionRecord,
  GraphFields,
  MetricRecord,
  ProfileScope,
  ProjectRecord,
  WorkRecord,
} from './observability-types';

export type {
  CacheFact,
  GraphFields,
  ProfileScope,
} from './observability-types';

const invocationContext: { storage?: AsyncLocalStorage<AnalysisObserver> } = {};
export function currentProfile(): AnalysisObserver | undefined {
  return invocationContext.storage?.getStore();
}
export function runWithProfile<T>(
  observer: AnalysisObserver,
  operation: () => T,
): T {
  invocationContext.storage ??= new AsyncLocalStorage();
  return invocationContext.storage.run(observer, operation);
}

type Terminal =
  | 'performed'
  | 'computed'
  | 'restored'
  | 'failed'
  | 'cancelled'
  | 'superseded';
function isUnsuccessful(
  end: Terminal,
): end is 'failed' | 'cancelled' | 'superseded' {
  return ['failed', 'cancelled', 'superseded'].includes(end);
}
type LinkKind = 'uses-result' | 'waits-for' | 'retry-of' | 'supersedes';
interface TaskFields {
  name?: string;
  queueWaitUs?: number;
  readyQueueUs?: number;
  dispatchToRunnerUs?: number;
  state?: string;
  runnerUs?: number;
}
interface RuntimeFields {
  entry?: string;
  limina?: string;
  typescript?: string;
  treeHash?: string;
  peakRssBytes?: number;
  finalRssBytes?: number;
  rssSamples?: number;
  rssSampleIntervalMs?: number;
}
export interface AnalysisProfile {
  schemaVersion: 2;
  metricRevision: 3;
  invocation: {
    id: string;
    command: string;
    result: 'passed' | 'failed';
    clock: 'main';
    commandInvocationUs: number;
    externalEndToEndUs: null;
    runUs: number | null;
    cachePolicy: string;
    profileOverhead: { inlineObservedUnionUs: number; finalWriteUs: null };
  };
  runtime: RuntimeFields & { node: string; platform: string; arch: string };
  coverage: {
    projectInventory: 'complete' | 'partial' | 'not-started';
    workDetail: 'complete' | 'partial';
    decisionDetail: 'partial';
    clockDomains: string[];
    detailsOmitted: number;
    omittedByKind: Record<string, number>;
  };
  projects: ProjectRecord[];
  contexts: ContextRecord[];
  providerRuns: ProviderRecord[];
  graphs: (GraphFields & { id: string })[];
  tasks: (TaskFields & { id: string })[];
  work: WorkRecord[];
  links: { kind: LinkKind; from: string; to: string }[];
  decisions: DecisionRecord[];
  metrics: MetricRecord[];
  summary: ReturnType<typeof summarizeProfile>;
  gaps: { code: string }[];
}
const detailBudget = 50_000;
const queryDetailBudget = 2048;
const queryLayers = new Set([
  'native-resolution',
  'native-syntax',
  'native-source-syntax',
  'resolved-config',
  'resolved-config-live-parse',
  'resolved-config-projection',
  'source-config-authority',
  'importer-facts',
  'vue-resolution',
  'vue-query',
]);
const invocationScope: ProfileScope = ['invocation'];

export class AnalysisObserver extends ProfileInventory {
  readonly #works = new Map<string, WorkRecord>();
  readonly #failureDetails = new Map<string, unknown>();
  readonly #graphs = new Map<string, GraphFields & { id: string }>();
  readonly #tasks = new Map<string, TaskFields & { id: string }>();
  readonly #decisions: DecisionRecord[] = [];
  readonly #metrics = new Map<string, MetricRecord>();
  readonly #links: { kind: LinkKind; from: string; to: string }[] = [];
  readonly #workStore = new AsyncLocalStorage<string>();
  readonly #providerStore = new AsyncLocalStorage<string>();
  readonly #rootWork: string;
  readonly #runtime: RuntimeFields = {};
  readonly #command: string;
  readonly #origin: number;
  #policy = 'not-requested';
  #dropped = 0;
  #hasDroppedWork = false;
  #queryDetailCount = 0;
  #omittedQueries = 0;
  #hasOmittedSemanticAdoption = false;
  readonly #omitted = new Map<string, number>();
  readonly #decisionIds = new Set<string>();
  #end?: number;
  #passed = false;
  #runUs: number | null = null;

  readonly invocationId: string = randomUUID();

  constructor(command: string, startedAt: number) {
    super();
    this.#command = command;
    this.#origin = startedAt;
    this.#rootWork = this.id('work');
    this.#works.set(this.#rootWork, {
      id: this.#rootWork,
      op: 'command',
      scope: invocationScope,
      end: 'open',
      startUs: 0,
    });
  }
  #retain(count: number, category: string): boolean {
    if (count < detailBudget) return true;
    this.#omitDetail(category);
    return false;
  }
  #omitDetail(category: string): void {
    this.#dropped++;
    this.#omitted.set(category, (this.#omitted.get(category) ?? 0) + 1);
  }
  #retainWork(op: string): boolean {
    if (this.#retain(this.#works.size, op)) return true;
    this.#hasDroppedWork = true;
    return false;
  }
  #isMissingWork(work: string | undefined): boolean {
    return (
      this.#works.size === detailBudget &&
      work !== undefined &&
      !this.#works.has(work)
    );
  }

  now(): number {
    return Math.max(0, Math.round((performance.now() - this.#origin) * 1000));
  }
  get currentWork(): string {
    return this.#workStore.getStore() ?? this.#rootWork;
  }
  get currentScope(): ProfileScope {
    return this.#works.get(this.currentWork)?.scope ?? invocationScope;
  }
  get currentOperation(): string | undefined {
    return this.#works.get(this.currentWork)?.op;
  }
  inWork<T>(id: string, operation: () => T): T {
    return this.#works.has(id)
      ? this.#workStore.run(id, operation)
      : operation();
  }
  currentProviderRun(): string | undefined {
    return this.#providerStore.getStore();
  }
  withProviderRun<T>(id: string, operation: () => T): T {
    return this.#providerStore.run(id, operation);
  }
  setPolicy(policy: string): void {
    this.#policy = policy;
  }
  runtime(fields: RuntimeFields): void {
    Object.assign(this.#runtime, fields);
  }
  runDuration(us: number): void {
    this.#runUs = us;
  }
  task(id: string, fields: TaskFields): void {
    this.#tasks.set(id, { ...this.#tasks.get(id), ...fields, id });
  }
  start(
    op: string,
    scope: ProfileScope = this.currentScope,
    parent: string = this.currentWork,
    pass?: number,
  ): string {
    const id = this.id('work');
    if (this.#retainWork(op))
      this.#works.set(id, {
        id,
        op,
        scope,
        parent,
        pass,
        end: 'open',
        startUs: this.now(),
      });
    return id;
  }
  finish(
    id: string,
    end: Terminal = 'performed',
    reason: string = 'operation-failed',
    scope?: ProfileScope,
  ): void {
    const work = this.#works.get(id);
    if (work?.end !== 'open') return;
    const { startUs, ...rest } = work;
    if (scope !== undefined) rest.scope = scope;
    const time: [number, number] = [startUs, this.now()];
    if (isUnsuccessful(end))
      this.#works.set(id, { ...rest, end, reason, time });
    else this.#works.set(id, { ...rest, end, time });
  }
  fail(id: string, detail: unknown, reason?: string): void {
    if (this.#works.get(id)?.end !== 'open') return;
    this.finish(id, 'failed', reason);
    if (detail !== undefined) this.#failureDetails.set(id, detail);
  }
  failureDetail(id: string): unknown {
    return this.#failureDetails.get(id);
  }
  finishSharedWait(
    id: string,
    producer: string,
    result: 'shared' | 'failed',
  ): void {
    const work = this.#works.get(id);
    if (work?.end !== 'open' || !this.#works.has(producer)) return;
    if (result === 'failed') {
      this.finish(id, 'failed', 'shared-producer-failed');
    } else {
      const { startUs, ...rest } = work;
      this.#works.set(id, {
        ...rest,
        end: 'shared',
        producer: { work: producer },
        reuse: 'joined',
        time: [startUs, this.now()],
      });
    }
    this.link('waits-for', id, producer);
  }
  notRun(op: string, scope: ProfileScope, reason: string): void {
    if (!this.#retainWork(op)) return;
    const id = this.id('work');
    this.#works.set(id, {
      id,
      op,
      scope,
      parent: this.currentWork,
      end: 'not-run',
      reason,
    });
  }
  share(
    op: string,
    scope: ProfileScope,
    producer: string,
    startUs?: number,
  ): void {
    if (!this.#retainWork(op)) return;
    const id = this.id('work');
    const base = {
      id,
      op,
      scope,
      parent: this.currentWork,
      end: 'shared' as const,
      producer: { work: producer },
    };
    if (startUs === undefined)
      this.#works.set(id, { ...base, reuse: 'ready', atUs: this.now() });
    else
      this.#works.set(id, {
        ...base,
        reuse: 'joined',
        time: [startUs, this.now()],
      });
    this.link(
      startUs === undefined ? 'uses-result' : 'waits-for',
      id,
      producer,
    );
  }
  link(kind: LinkKind, from: string, to: string): void {
    if (this.#isMissingWork(from) || this.#isMissingWork(to)) {
      this.#omitDetail(kind);
      return;
    }
    if (this.#retain(this.#links.length, kind))
      this.#links.push({ kind, from, to });
  }
  decision(
    layer: string,
    fact: CacheFact,
    subject?: string,
    work: string = this.currentWork,
  ): string {
    const id = this.id('decision');
    const isQuery = queryLayers.has(layer);
    if (isQuery) {
      const metric = `cache.${layer}.${fact.stage}.${fact.outcome}`;
      this.metric(metric, this.currentScope, 'calls', 1);
      if (layer === 'native-resolution' && fact.outcome === 'adopted')
        this.metric(`${metric}.${fact.origin}`, this.currentScope, 'calls', 1);
      if (this.#queryDetailCount >= queryDetailBudget) {
        this.#hasOmittedSemanticAdoption ||=
          fact.outcome === 'adopted' && isSemanticFactLayer(layer);
        this.#omittedQueries++;
        this.#omitted.set(layer, (this.#omitted.get(layer) ?? 0) + 1);
        return id;
      }
    }
    if (this.#isMissingWork(work)) {
      this.#omitDetail(layer);
      return id;
    }
    if (isQuery) this.#queryDetailCount++;
    if (!this.#retain(this.#decisions.length - this.#queryDetailCount, layer))
      return id;
    const row: DecisionRecord = { ...fact, id, work, layer, subject };
    if (row.basis?.some((key) => !this.#decisionIds.has(key))) {
      row.basis = row.basis.filter((key) => this.#decisionIds.has(key));
    }
    if (
      row.causes?.some(
        (cause) => cause.decision && !this.#decisionIds.has(cause.decision),
      )
    ) {
      const [first, ...rest] = row.causes;
      const available = (cause: typeof first) =>
        cause.decision && !this.#decisionIds.has(cause.decision)
          ? { code: 'decision-detail-unavailable' }
          : cause;
      row.causes = [available(first), ...rest.map(available)];
    }
    this.#decisions.push(row);
    this.#decisionIds.add(id);
    return id;
  }
  graph(id: string, fields: GraphFields): void {
    const previous = this.#graphs.get(id);
    const row = { ...previous, ...fields, id };
    if (this.#isMissingWork(row.request)) {
      delete row.request;
      this.#omitDetail('graph.request');
    }
    if (this.#isMissingWork(row.producer)) {
      delete row.producer;
      this.#omitDetail('graph.producer');
    }
    if (this.#isMissingWork(row.applied?.work)) {
      delete row.applied;
      this.#omitDetail('graph.applied');
    }
    if (fields.prepared && previous?.prepared) {
      const gates = new Map(previous.prepared.map((mark) => [mark.gate, mark]));
      for (const mark of fields.prepared)
        if (!gates.has(mark.gate)) gates.set(mark.gate, mark);
      row.prepared = gates.values().toArray();
    }
    this.#graphs.set(id, row);
  }
  metric(
    key: string,
    scope: ProfileScope,
    unit: MetricRecord['unit'],
    value: number,
  ): void {
    const id = JSON.stringify([key, scope, unit]);
    const total = (this.#metrics.get(id)?.value ?? 0) + value;
    this.#metrics.set(id, { key, scope, unit, kind: 'counter', value: total });
  }
  sumElapsed<T>(key: string, scope: ProfileScope, action: () => T): T {
    const start = this.now();
    try {
      return action();
    } finally {
      this.metric(key, scope, 'us', this.now() - start);
    }
  }
  stop(isPassed: boolean, error?: unknown): void {
    if (this.#end !== undefined) return;
    if (isPassed) this.finish(this.#rootWork);
    else this.fail(this.#rootWork, error, 'command-failed');
    const command = this.#works.get(this.#rootWork);
    this.#end =
      command && 'time' in command && command.time
        ? command.time[1]
        : this.now();
    this.#passed = isPassed;
  }
  snapshot(): AnalysisProfile {
    const work = this.#works.values().toArray();
    const graphs = this.#graphs.values().toArray();
    const projects = this.projects.values().toArray();
    const contexts = this.contexts.values().toArray();
    const metrics = this.#metrics.values().toArray();
    const decisions = [...this.#decisions];
    const tasks = this.#tasks.values().toArray();
    const summary = summarizeProfile({
      work,
      links: this.#links,
      graphs,
      projects,
      contexts,
      metrics,
      decisions,
      cachePolicy: this.#policy,
      inventoryComplete: this.hasCompleteInventory,
      dropped: this.#dropped,
      hasOmittedSemanticAdoption: this.#hasOmittedSemanticAdoption,
      isCommandOnly:
        tasks.length > 0 && tasks.every((task) => task.name === 'command'),
    });
    const end = this.#end ?? this.now();
    const observerIntervals = work.flatMap((w) =>
      w.op.startsWith('profile.') && 'time' in w && w.time
        ? [[Math.min(w.time[0], end), Math.min(w.time[1], end)] as const]
        : [],
    );
    return {
      schemaVersion: 2 as const,
      metricRevision: 3 as const,
      invocation: {
        id: this.invocationId,
        command: this.#command,
        result: this.#passed ? 'passed' : 'failed',
        clock: 'main',
        commandInvocationUs: end,
        runUs: this.#runUs,
        externalEndToEndUs: null,
        cachePolicy: this.#policy,
        profileOverhead: {
          inlineObservedUnionUs: intervalUnionUs(observerIntervals),
          finalWriteUs: null,
        },
      },
      runtime: {
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        ...this.#runtime,
      },
      coverage: {
        projectInventory: this.hasCompleteInventory
          ? 'complete'
          : projects.length > 0
            ? 'partial'
            : 'not-started',
        workDetail: this.#hasDroppedWork ? 'partial' : 'complete',
        decisionDetail: 'partial',
        clockDomains: ['main'],
        detailsOmitted: this.#dropped + this.#omittedQueries,
        omittedByKind: Object.fromEntries(this.#omitted),
      },
      projects,
      providerRuns: this.providers.values().toArray(),
      contexts,
      graphs,
      tasks,
      work,
      links: [...this.#links],
      decisions,
      metrics,
      summary,
      gaps: [
        { code: 'external-clock-unavailable' },
        { code: 'final-write-outside-artifact' },
        ...(this.#dropped + this.#omittedQueries > 0
          ? [{ code: 'detail-budget-exhausted' }]
          : []),
      ],
    };
  }
}
