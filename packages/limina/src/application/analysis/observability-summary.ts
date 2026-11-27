import type {
  ContextRecord,
  DecisionRecord,
  GraphFields,
  Interval,
  MetricRecord,
  ProjectRecord,
  WorkRecord,
} from './observability-types';

interface SummaryInput {
  work: readonly WorkRecord[];
  graphs: readonly (GraphFields & { id: string })[];
  projects: readonly ProjectRecord[];
  contexts: readonly ContextRecord[];
  decisions: readonly DecisionRecord[];
  metrics: readonly MetricRecord[];
  links?: readonly {
    kind: 'retry-of' | 'uses-result' | 'waits-for' | 'supersedes';
    from: string;
    to: string;
  }[];
  cachePolicy: string;
  inventoryComplete: boolean;
  dropped: number;
  hasOmittedSemanticAdoption?: boolean;
  isCommandOnly?: boolean;
}

type Graph = SummaryInput['graphs'][number];
type Mode =
  | 'warm'
  | 'cold'
  | 'incremental'
  | 'mixed'
  | 'not-applicable'
  | 'unavailable';

const auxiliaryContextRoles = new Set([
  'declaration-candidate',
  'implementation-reference',
  'execution-inputs',
]);

function isValidInterval(interval: Interval): boolean {
  return (
    Number.isSafeInteger(interval[0]) &&
    Number.isSafeInteger(interval[1]) &&
    interval[0] >= 0 &&
    interval[1] >= interval[0]
  );
}

export function intervalUnionUs(intervals: readonly Interval[]): number {
  const sorted = intervals
    .filter(isValidInterval)
    .sort((left, right) => left[0] - right[0]);
  let end = 0;
  let total = 0;
  for (const [start, nextEnd] of sorted) {
    if (!(nextEnd > end)) {
      continue;
    }

    total += nextEnd - Math.max(end, start);
    end = nextEnd;
  }
  return total;
}

function incrementGroup<T>(
  map: Map<string, T[]>,
  key: string | undefined,
  value: T,
): void {
  if (key === undefined) return;
  const group = map.get(key);
  if (group === undefined) map.set(key, [value]);
  else group.push(value);
}

function timeOf(work: WorkRecord): Interval | undefined {
  return 'time' in work && work.time && isValidInterval(work.time)
    ? work.time
    : undefined;
}

function cyclicParents(workById: Map<string, WorkRecord>): Set<string> {
  const seen = new Set<string>();
  const cyclic = new Set<string>();
  for (const work of workById.values()) {
    let id: string | undefined = work.id;
    const path = new Set<string>();
    while (id !== undefined && !seen.has(id) && !path.has(id)) {
      path.add(id);
      id = workById.get(id)?.parent;
    }
    if (id !== undefined && path.has(id)) {
      let isInCycle = false;
      for (const member of path) {
        isInCycle ||= member === id;
        if (isInCycle) cyclic.add(member);
      }
    }
    for (const member of path) seen.add(member);
  }
  return cyclic;
}

function workTiming(
  work: WorkRecord,
  children: readonly WorkRecord[],
  isIncomplete: boolean,
) {
  const time = timeOf(work);
  if (!time) return { work: work.id, inclusiveUs: null, exclusiveUs: null };
  const inclusiveUs = time[1] - time[0];
  const contained: Interval[] = [];
  for (const child of children) {
    if (
      child.end === 'not-run' ||
      (child.end === 'shared' && child.reuse === 'ready')
    )
      continue;
    const interval = timeOf(child);
    if (
      !interval ||
      interval[0] < time[0] ||
      interval[1] > time[1] ||
      child.id === work.id
    )
      return { work: work.id, inclusiveUs, exclusiveUs: null };
    contained.push(interval);
  }
  return {
    work: work.id,
    inclusiveUs,
    exclusiveUs: isIncomplete ? null : inclusiveUs - intervalUnionUs(contained),
  };
}

function isNonExecution(work: WorkRecord): boolean {
  return (
    work.end === 'shared' ||
    work.op.startsWith('graph.wait.') ||
    work.op.startsWith('queue.') ||
    work.op.startsWith('profile.')
  );
}

function programCounts(work: readonly WorkRecord[]) {
  const counts = new Map<
    string,
    {
      op: string;
      attempts: number;
      created: number;
      failed: number;
      pending: number;
      passes: number[];
    }
  >();
  for (const item of work) {
    if (!item.op.endsWith('-program-create') || item.end === 'shared') continue;
    const count = counts.get(item.op) ?? {
      op: item.op,
      attempts: 0,
      created: 0,
      failed: 0,
      pending: 0,
      passes: [],
    };
    if (item.end !== 'not-run') count.attempts++;
    count.failed += Number(item.end === 'failed');
    count.pending += Number(item.end === 'open');
    count.created += Number(
      item.end === 'performed' || item.end === 'computed',
    );
    if (item.pass !== undefined) count.passes.push(item.pass);
    counts.set(item.op, count);
  }
  return counts.values().toArray();
}

interface ScopeSummary {
  state:
    | 'failed'
    | 'partial'
    | 'rebuilt'
    | 'restored'
    | 'covered-by-graph'
    | 'skipped'
    | 'unavailable';
  workUnionUs: number | null;
  observedWorkUnionUs: number;
  sharedWaitUs: number | null;
  failedAttempts: number;
  programs: {
    op: string;
    attempts: number;
    created: number;
    failed: number;
    pending: number;
    passes: number[];
  }[];
  metrics: MetricRecord[];
}

interface GraphSummary {
  graph: string;
  purpose?: string;
  requestGate?: GraphFields['requestGate'];
  prepared: { gate: 'core' | 'preflight'; atUs: number } | null;
  graphPrepareElapsedUs: number | null;
  requestDeliveryUs: number | null;
  referenceAnalysisWorkUnionUs: number | null;
  graphProjectionWorkUnionUs: number | null;
  artifactsApplyElapsedUs: number | null;
  receiptAtUs: number | null;
}

interface Summary {
  mode: Mode;
  basis: string[];
  graphModes: {
    graph: string;
    providerRun?: string;
    purpose?: string;
    mode: Mode;
    basis: string[];
  }[];
  firstCompleteGraphPrepared: GraphSummary['prepared'];
  firstCompleteReceiptCommittedUs: number | null;
  projectRows: (ScopeSummary & { project: string })[];
  contextRows: (ScopeSummary & { context: string })[];
  graphRows: GraphSummary[];
  workTimings: {
    work: string;
    inclusiveUs: number | null;
    exclusiveUs: number | null;
  }[];
}

function isMeasuredSharedWait(work: WorkRecord): boolean {
  return (
    (work.end === 'shared' && work.reuse === 'joined') ||
    (work.end === 'failed' && work.reason === 'shared-producer-failed')
  );
}

function summarizeLinks(
  input: SummaryInput,
  workById: Map<string, WorkRecord>,
  owners: Map<string, string>,
) {
  const assigned = new Set(
    input.work.flatMap((work) =>
      work.scope[0] === 'project' || work.scope[0] === 'context'
        ? [work.id]
        : [],
    ),
  );
  const scopeOwner = workOwners(assigned, workById);
  const missingWaitProjects = new Set<string>();
  const missingWaitContexts = new Set<string>();
  const retried = new Map<string, string[]>();
  const successfulRetries: string[] = [];
  const links = input.links ?? [];
  for (const link of links) {
    const work = workById.get(link.from);
    if (!work) continue;
    if (link.kind === 'retry-of') {
      incrementGroup(retried, work.id, link.to);
      if (['performed', 'computed', 'restored'].includes(work.end))
        successfulRetries.push(work.id);
    }
    if (link.kind !== 'waits-for' || isMeasuredSharedWait(work)) continue;
    const owner = scopeOwner(work.id);
    const scope = owner && workById.get(owner)?.scope;
    if (!scope) continue;
    if (scope[0] === 'project') missingWaitProjects.add(scope[1]);
    else if (scope[0] === 'context') {
      missingWaitContexts.add(scope[1]);
      const project = owners.get(scope[1]);
      if (project) missingWaitProjects.add(project);
    }
  }
  const recovered = new Set<string>();
  while (successfulRetries.length > 0) {
    const prior = retried.get(successfulRetries.pop()!) ?? [];
    for (const id of prior) {
      if (recovered.has(id)) continue;
      recovered.add(id);
      successfulRetries.push(id);
    }
  }
  const recoveredAncestor = workOwners(recovered, workById);
  return { missingWaitContexts, missingWaitProjects, recoveredAncestor };
}

function rowValues(
  work: readonly WorkRecord[],
  metrics: readonly MetricRecord[],
  isAdopted: boolean,
  isCovered: boolean,
  dropped: number,
  hasMissingWait: boolean,
  recoveredAncestor: (id: string) => string | undefined,
  auxiliaryContexts?: ReadonlySet<string>,
): ScopeSummary {
  const measured: Interval[] = [];
  let sharedWaitUs = 0;
  let failedAttempts = 0;
  let hasTerminalFailure = false;
  let isComputed = false;
  let isRestored = isAdopted;
  let isSkipped = false;
  let isIncomplete = dropped > 0;
  for (const item of work) {
    const time = timeOf(item);
    isIncomplete ||= item.end === 'open' || ('time' in item && !time);
    if (time && !isNonExecution(item)) measured.push(time);
    if (time && isMeasuredSharedWait(item)) sharedWaitUs += time[1] - time[0];
    if (item.end === 'failed') {
      failedAttempts++;
      hasTerminalFailure ||= recoveredAncestor(item.id) === undefined;
    }
    isComputed ||=
      item.end === 'computed' &&
      (auxiliaryContexts === undefined ||
        (item.op !== 'framework-execution-input-program-create' &&
          (item.scope[0] !== 'context' ||
            !auxiliaryContexts.has(item.scope[1]))));
    isRestored ||= item.end === 'restored';
    isSkipped ||=
      item.end === 'not-run' &&
      [
        'project.analyze',
        'context.analyze',
        'native-baseline-context',
        'locked-project-dependencies',
      ].includes(item.op);
  }
  const hasSuccess = isComputed || isRestored;
  const state =
    hasTerminalFailure || (!hasSuccess && failedAttempts > 0)
      ? 'failed'
      : (isComputed && isRestored) || (hasSuccess && isIncomplete)
        ? 'partial'
        : isComputed
          ? 'rebuilt'
          : isRestored
            ? 'restored'
            : isCovered
              ? 'covered-by-graph'
              : isSkipped &&
                  !isIncomplete &&
                  work.every((item) => item.end === 'not-run')
                ? 'skipped'
                : 'unavailable';
  const isKnown = !isIncomplete && work.length > 0;
  return {
    state,
    workUnionUs: isKnown ? intervalUnionUs(measured) : null,
    observedWorkUnionUs: intervalUnionUs(measured),
    sharedWaitUs: isKnown && !hasMissingWait ? sharedWaitUs : null,
    failedAttempts,
    programs: programCounts(work),
    metrics: [...metrics],
  };
}

function partitionScope<T extends { scope: WorkRecord['scope'] }>(
  values: readonly T[],
  owners: Map<string, string>,
) {
  const projects = new Map<string, T[]>();
  const contexts = new Map<string, T[]>();
  for (const value of values) {
    const [kind, id] = value.scope;
    if (kind === 'project') incrementGroup(projects, id, value);
    if (kind !== 'context') {
      continue;
    }

    incrementGroup(contexts, id, value);
    incrementGroup(projects, owners.get(id), value);
  }
  return { projects, contexts };
}

function isSemanticContextLayer(layer: string): boolean {
  return layer === 'native-context' || layer === 'vue-context';
}

export function isSemanticFactLayer(layer: string): boolean {
  return (
    isSemanticContextLayer(layer) ||
    [
      'importer-facts',
      'native-resolution',
      'vue-resolution',
      'vue-query',
    ].includes(layer)
  );
}

export function* ownedContextCacheDecisions(
  input: Pick<SummaryInput, 'projects' | 'contexts' | 'work' | 'decisions'>,
  workById: ReadonlyMap<string, WorkRecord> = new Map(
    input.work.map((work) => [work.id, work]),
  ),
  owners: ReadonlyMap<string, string> = new Map(
    input.contexts.map(({ id, project }) => [id, project]),
  ),
): Generator<{
  decision: DecisionRecord;
  project: string;
  context: string | undefined;
}> {
  const byPath = new Map(input.projects.map(({ path, id }) => [path, id]));
  for (const decision of input.decisions) {
    if (!isSemanticContextLayer(decision.layer)) continue;
    const scope = workById.get(decision.work)?.scope;
    const context = scope?.[0] === 'context' ? scope[1] : undefined;
    const scopeProject =
      scope?.[0] === 'project' ? scope[1] : context && owners.get(context);
    const project =
      (decision.subject && byPath.get(decision.subject)) || scopeProject;
    if (project !== undefined)
      yield {
        decision,
        project,
        context: scopeProject === project ? context : undefined,
      };
  }
}

function graphRows(
  graphs: readonly Graph[],
  works: Map<string, WorkRecord>,
  dropped: number,
) {
  const owner = workOwners(
    new Set(
      graphs.flatMap((graph) => (graph.producer ? [graph.producer] : [])),
    ),
    works,
  );
  const artifactOwner = workOwners(
    new Set(graphs.flatMap(({ applied }) => (applied ? [applied.work] : []))),
    works,
  );
  const reference = new Map<string, WorkRecord[]>();
  const projection = new Map<string, WorkRecord[]>();
  const appliedArtifacts = new Map<string, WorkRecord[]>();
  for (const work of works.values()) {
    if (work.op === 'graph.apply.artifacts') {
      incrementGroup(appliedArtifacts, artifactOwner(work.id), work);
      continue;
    }
    if (work.op === 'reference-analysis')
      incrementGroup(reference, owner(work.id), work);
    else if (work.op === 'graph-projection')
      incrementGroup(projection, owner(work.id), work);
  }
  function operationUnion(group: Map<string, WorkRecord[]>, producer?: string) {
    const records = producer && group.get(producer);
    if (!records || dropped) return null;
    const intervals: Interval[] = [];
    for (const work of records) {
      const interval = timeOf(work);
      if (!interval) return null;
      intervals.push(interval);
    }
    return intervalUnionUs(intervals);
  }
  const canonical = new Map(graphs.map((graph) => [graph.id, graph]));
  return graphs.map((graph) => {
    const result = (graph.result && canonical.get(graph.result)) || graph;
    const prepared = result.prepared ?? [];
    const gate = graph.requestGate;
    const preparation =
      prepared.find(
        (mark) => mark.gate === (gate === 'core' ? 'core' : 'preflight'),
      ) ??
      (gate === undefined
        ? prepared.find((mark) => mark.gate === 'core')
        : undefined);
    const delivery = graph.deliveredAtUs;
    const latency = (at: number | undefined) =>
      at !== undefined &&
      graph.requestAtUs !== undefined &&
      at >= graph.requestAtUs
        ? at - graph.requestAtUs
        : null;
    return {
      graph: graph.id,
      ...(graph.purpose !== undefined && { purpose: graph.purpose }),
      ...(gate !== undefined && { requestGate: gate }),
      prepared: preparation ?? null,
      graphPrepareElapsedUs:
        gate === 'applied' || gate === 'receipt'
          ? null
          : latency(preparation?.atUs),
      requestDeliveryUs: latency(delivery),
      referenceAnalysisWorkUnionUs: operationUnion(reference, result.producer),
      graphProjectionWorkUnionUs: operationUnion(projection, result.producer),
      artifactsApplyElapsedUs: operationUnion(
        appliedArtifacts,
        result.applied?.work,
      ),
      receiptAtUs: result.receipt?.atUs ?? null,
    };
  });
}

function workOwners(
  producers: ReadonlySet<string>,
  workById: Map<string, WorkRecord>,
) {
  const owners = new Map<string, string | undefined>();
  return (start: string) => {
    let key: string | undefined = start;
    const seen = new Set<string>();
    while (
      key !== undefined &&
      !producers.has(key) &&
      !owners.has(key) &&
      !seen.has(key)
    ) {
      seen.add(key);
      key = workById.get(key)?.parent;
    }
    const owner = key && (producers.has(key) ? key : owners.get(key));
    for (const member of seen) owners.set(member, owner);
    return owner;
  };
}

function decisionChain(
  local: readonly DecisionRecord[],
  byId: Map<string, DecisionRecord>,
) {
  const found = new Map<string, DecisionRecord>();
  const pending = [...local];
  while (pending.length > 0) {
    const decision = pending.pop()!;
    if (found.has(decision.id)) continue;
    found.set(decision.id, decision);
    const references = [...(decision.basis ?? [])];
    const causes = decision.causes ?? [];
    for (const cause of causes)
      if (cause.decision) references.push(cause.decision);
    for (const reference of references) {
      const upstream = byId.get(reference);
      if (upstream && !found.has(reference)) pending.push(upstream);
    }
  }
  return found.values().toArray();
}

function isSnapshotDecision({ layer }: DecisionRecord): boolean {
  return layer === 'analysis-snapshot' || layer === 'analysis-snapshot-facts';
}

function isRejectedBaseline(decision: DecisionRecord): boolean {
  return ['absent', 'corrupt', 'rejected'].includes(decision.outcome);
}

function isPriorDiskUse(decision: DecisionRecord): boolean {
  return (
    decision.outcome === 'adopted' &&
    isSemanticFactLayer(decision.layer) &&
    (decision.origin === 'prior-disk' || decision.origin === 'mixed')
  );
}

function isGraphSemanticProgram(
  work: WorkRecord,
  contexts: ReadonlyMap<string, ContextRecord>,
): boolean {
  if (
    ![
      'native-program-create',
      'vue-program-create',
      'astro-program-create',
      'svelte-program-create',
    ].includes(work.op) ||
    work.end === 'not-run' ||
    work.end === 'shared'
  )
    return false;
  if (work.scope[0] !== 'context') return true;
  const role = contexts.get(work.scope[1])?.role;
  return role === undefined || !auxiliaryContextRoles.has(role);
}

function classifyFactUse(input: {
  decisions: readonly DecisionRecord[];
  byId: Map<string, DecisionRecord>;
  program?: WorkRecord;
}): { mode: 'warm' | 'incremental'; decision: DecisionRecord } | undefined {
  const diskUses = input.decisions.filter(
    (decision) =>
      decision.outcome === 'adopted' &&
      isSemanticFactLayer(decision.layer) &&
      decisionChain([decision], input.byId).some(isPriorDiskUse),
  );
  const context = diskUses.find((decision) =>
    isSemanticContextLayer(decision.layer),
  );
  const adopted = context ?? diskUses[0];
  if (adopted === undefined) return undefined;
  return {
    decision: adopted,
    mode:
      context !== undefined && input.program === undefined
        ? 'warm'
        : 'incremental',
  };
}

function classifyManagedBypass(
  bypass: DecisionRecord,
  work: WorkRecord,
  local: readonly DecisionRecord[],
  byId: Map<string, DecisionRecord>,
  isForcedCold: boolean,
): { mode: Mode; basis: string[] } {
  const basis = [bypass.id, work.id];
  if (isForcedCold) return { mode: 'cold', basis };
  const consumed = local.find(
    (decision) =>
      decision.outcome === 'adopted' &&
      isSemanticContextLayer(decision.layer) &&
      decisionChain([decision], byId).some(
        (upstream) =>
          upstream.outcome === 'adopted' &&
          isSemanticContextLayer(upstream.layer) &&
          (upstream.origin === 'prior-disk' || upstream.origin === 'mixed'),
      ),
  );
  if (consumed) return { mode: 'incremental', basis: [...basis, consumed.id] };

  // A managed graph can reuse work done in this invocation after a cold start.
  // An adopted snapshot alone cannot prove that its semantic facts were used.
  const snapshots = decisionChain([bypass], byId).filter(isSnapshotDecision);
  const cold = snapshots.find(isRejectedBaseline);
  const hasPossiblePrior = snapshots.some(
    (d) => d.outcome === 'adopted' && d.origin !== 'invocation-memory',
  );
  return cold !== undefined && !hasPossiblePrior
    ? { mode: 'cold', basis: [...basis, cold.id] }
    : { mode: 'unavailable', basis };
}

function classifyGraph(
  graph: Graph,
  work: WorkRecord | undefined,
  local: readonly DecisionRecord[],
  snapshots: readonly DecisionRecord[],
  policy: string,
  byId: Map<string, DecisionRecord>,
  hasOmittedSemanticAdoption: boolean,
  program?: WorkRecord,
) {
  const basis: string[] = [];
  const result = (mode: Mode) => ({ mode, basis });
  if (
    !work ||
    (graph.purpose !== 'dependency-analysis' && !graph.prepared?.length) ||
    work.end !== graph.source
  )
    return result('unavailable');
  const adopted = local.find(
    (d) => d.layer === 'analysis-graph' && d.outcome === 'adopted',
  );
  if (adopted?.outcome === 'adopted') {
    basis.push(adopted.id);
    if (adopted.origin === 'mixed') return result('mixed');
    if (adopted.origin === 'invocation-memory')
      return { mode: 'memory' as const, basis };
    if (adopted.origin !== 'prior-disk') return result('unavailable');
    if (graph.source === 'restored') {
      const prior = snapshots.find(
        (d) => d.outcome === 'adopted' && d.origin === 'prior-disk',
      );
      if (prior) basis.push(prior.id);
      return result('warm');
    }
  }
  if (graph.source !== 'computed') return result('unavailable');
  const isForcedCold = ['forced', 'force', 'disabled'].includes(policy);
  const managedBypass = local.find(
    (d) =>
      d.layer === 'analysis-graph' &&
      d.outcome === 'bypassed' &&
      d.causes.some(
        ({ code }) =>
          code === 'producer-build-plan' || code === 'managed-execution-view',
      ),
  );
  if (managedBypass)
    return classifyManagedBypass(
      managedBypass,
      work,
      local,
      byId,
      isForcedCold,
    );

  const prior = snapshots.find(
    (d) => d.outcome === 'adopted' && d.origin === 'prior-disk',
  );
  const rejected = local.find(
    (d) => d.layer === 'analysis-graph' && isRejectedBaseline(d),
  );
  if (prior && rejected) {
    basis.push(prior.id, rejected.id, work.id);
    return result('incremental');
  }
  const facts = isForcedCold
    ? undefined
    : classifyFactUse({ decisions: local, byId, program });
  if (facts !== undefined) {
    basis.push(work.id, facts.decision.id);
    if (program !== undefined) basis.push(program.id);
    return result(facts.mode);
  }
  const cold = snapshots.find(isRejectedBaseline);
  if (cold || isForcedCold) {
    if (cold) basis.push(cold.id);
    basis.push(work.id);
    return result('cold');
  }
  const rebuilt = local.find(
    (decision) =>
      isSemanticContextLayer(decision.layer) &&
      decision.outcome === 'not-adopted',
  );
  if (
    !hasOmittedSemanticAdoption &&
    rebuilt !== undefined &&
    program?.end === 'computed' &&
    local.every(
      (decision) =>
        decision.outcome !== 'adopted' ||
        (decision.origin !== 'unknown' &&
          decision.origin !== 'invocation-memory'),
    )
  ) {
    basis.push(rebuilt.id, work.id, program.id);
    return result('cold');
  }
  return result('unavailable');
}

function deriveMode(input: SummaryInput, workById: Map<string, WorkRecord>) {
  const completed = input.graphs.filter(
    (g) => g.source === 'computed' || g.source === 'restored',
  );
  const producerIds = new Set(
    completed.flatMap((graph) => (graph.producer ? [graph.producer] : [])),
  );
  const rootToProducers = new Map<string, string[]>();
  for (const producerId of producerIds) {
    rootToProducers.set(producerId, [producerId]);
  }
  const links = input.links ?? [];
  for (const link of links) {
    if (link.kind !== 'uses-result' || !producerIds.has(link.from)) continue;
    incrementGroup(rootToProducers, link.to, link.from);
  }
  const owner = workOwners(new Set(rootToProducers.keys()), workById);
  const ownersOf = (workId: string): readonly string[] => {
    const root = owner(workId);
    return root === undefined ? [] : (rootToProducers.get(root) ?? []);
  };
  const byId = new Map(input.decisions.map((d) => [d.id, d]));
  const contexts = new Map(
    input.contexts.map((context) => [context.id, context]),
  );
  const programs = new Map<string, WorkRecord>();
  for (const work of input.work) {
    if (!isGraphSemanticProgram(work, contexts)) continue;
    for (const producer of ownersOf(work.id)) {
      if (!programs.has(producer)) programs.set(producer, work);
    }
  }
  const facts = new Map<string, DecisionRecord[]>();
  for (const decision of input.decisions) {
    if (
      decision.layer !== 'analysis-graph' &&
      !isSemanticContextLayer(decision.layer) &&
      !(decision.outcome === 'adopted' && isSemanticFactLayer(decision.layer))
    )
      continue;
    for (const producer of ownersOf(decision.work)) {
      incrementGroup(facts, producer, decision);
    }
  }
  const globalSnapshots = input.decisions.filter(isSnapshotDecision);
  const adoptions = globalSnapshots.filter((d) => d.stage === 'adoption');
  const isUnambiguousBaseline = adoptions.length <= 1;
  const coldInvocation = adoptions.every(
    (d) => d.outcome !== 'adopted' || d.origin === 'invocation-memory',
  )
    ? globalSnapshots.find(isRejectedBaseline)
    : undefined;
  const graphModes = completed.map((graph) => {
    const producer = graph.producer ?? '';
    const local = facts.get(producer) ?? [];
    const chain = decisionChain(local, byId);
    const localSnapshots = chain.filter(isSnapshotDecision);
    const snapshots =
      isUnambiguousBaseline && localSnapshots.length === 0
        ? globalSnapshots
        : localSnapshots;
    const { mode, basis } = input.dropped
      ? { mode: 'unavailable' as const, basis: [] }
      : classifyGraph(
          graph,
          workById.get(producer),
          local,
          coldInvocation === undefined
            ? snapshots
            : [...snapshots, coldInvocation],
          input.cachePolicy,
          byId,
          input.hasOmittedSemanticAdoption ?? false,
          programs.get(producer),
        );
    return {
      graph: graph.id,
      ...(graph.providerRun !== undefined && {
        providerRun: graph.providerRun,
      }),
      ...(graph.purpose !== undefined && { purpose: graph.purpose }),
      mode,
      basis,
    };
  });
  const modes = new Set(graphModes.map((g) => g.mode));
  const basis = [...new Set(graphModes.flatMap((g) => g.basis))];
  let mode: Mode;
  if (input.dropped || modes.has('unavailable')) mode = 'unavailable';
  else if (modes.size > 1 || modes.has('mixed')) mode = 'mixed';
  else if (modes.has('memory')) mode = 'unavailable';
  else if (modes.size === 1) mode = graphModes[0]!.mode as Mode;
  else
    mode =
      input.graphs.length > 0 ||
      input.contexts.length > 0 ||
      input.projects.length > 0 ||
      input.work.some(
        (work) =>
          work.end === 'computed' ||
          (work.op === 'command' &&
            work.end === 'failed' &&
            !input.isCommandOnly),
      )
        ? 'unavailable'
        : 'not-applicable';
  return {
    mode,
    basis,
    graphModes: graphModes.map((g) => ({
      ...g,
      mode: g.mode === 'memory' ? 'unavailable' : g.mode,
    })),
  };
}

export function summarizeProfile(input: SummaryInput): Summary {
  const workById = new Map(input.work.map((work) => [work.id, work]));
  const owners = new Map(
    input.contexts.map((context) => [context.id, context.project]),
  );
  const auxiliaryContexts = new Set(
    input.contexts
      .filter(({ role }) => auxiliaryContextRoles.has(role))
      .map(({ id }) => id),
  );
  const links = summarizeLinks(input, workById, owners);
  const scopedWork = partitionScope(input.work, owners);
  const scopedMetrics = partitionScope(input.metrics, owners);
  const adoptedProjects = new Set<string>();
  const adoptedContexts = new Set<string>();
  for (const { decision, project, context } of ownedContextCacheDecisions(
    input,
    workById,
    owners,
  )) {
    if (decision.outcome !== 'adopted') continue;
    adoptedProjects.add(project);
    if (context !== undefined) adoptedContexts.add(context);
  }
  const covered = new Set(
    input.graphs.flatMap((graph) =>
      graph.source === 'restored' && graph.prepared?.length
        ? (graph.projects ?? [])
        : [],
    ),
  );
  const projectRows = input.projects
    .map(({ id }) => ({
      project: id,
      ...rowValues(
        scopedWork.projects.get(id) ?? [],
        scopedMetrics.projects.get(id) ?? [],
        adoptedProjects.has(id),
        covered.has(id),
        input.dropped,
        links.missingWaitProjects.has(id),
        links.recoveredAncestor,
        auxiliaryContexts,
      ),
    }))
    .sort((a, b) => (b.workUnionUs ?? -1) - (a.workUnionUs ?? -1));
  const contextRows = input.contexts.map(({ id }) => ({
    context: id,
    ...rowValues(
      scopedWork.contexts.get(id) ?? [],
      scopedMetrics.contexts.get(id) ?? [],
      adoptedContexts.has(id),
      false,
      input.dropped,
      links.missingWaitContexts.has(id),
      links.recoveredAncestor,
    ),
  }));
  const children = new Map<string, WorkRecord[]>();
  for (const work of input.work) incrementGroup(children, work.parent, work);
  const cyclic = cyclicParents(workById);
  const workTimings = input.work.map((work) =>
    workTiming(
      work,
      children.get(work.id) ?? [],
      input.dropped > 0 || cyclic.has(work.id),
    ),
  );
  const graphs = graphRows(input.graphs, workById, input.dropped);
  const complete = graphs.filter((graph) => graph.purpose === 'complete');
  const preflightRequests = new Set(
    input.graphs.flatMap(({ request, requestGate }) =>
      requestGate === 'preflight' && request ? [request] : [],
    ),
  );
  const enclosingPreflight = workOwners(preflightRequests, workById);
  const prepared = input.graphs
    .flatMap(({ prepared, producer, purpose }) => {
      if (purpose !== 'complete' || prepared === undefined) return [];
      // Readiness belongs to the work that prepared the result. Subsequent
      // requests, including a materialization that fails, cannot move it.
      const isIndependentCore =
        producer !== undefined &&
        workById.has(producer) &&
        !enclosingPreflight(producer);
      return prepared.filter(
        ({ gate }) => gate === 'preflight' || isIndependentCore,
      );
    })
    .sort((a, b) => a.atUs - b.atUs);
  const receipts = complete
    .flatMap((graph) => (graph.receiptAtUs === null ? [] : [graph.receiptAtUs]))
    .sort((a, b) => a - b);
  return {
    ...deriveMode(input, workById),
    firstCompleteGraphPrepared: prepared[0] ?? null,
    firstCompleteReceiptCommittedUs: receipts[0] ?? null,
    projectRows,
    contextRows,
    graphRows: graphs,
    workTimings,
  };
}
