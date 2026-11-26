import type { AnalysisProfile } from '../application/analysis/observability';
import { ownedContextCacheDecisions } from '../application/analysis/observability-summary';
import type { LiminaArtifactNamespace } from '../domain/artifacts/namespace';
import {
  type FlowRenderFlowLine,
  formatElapsedTime,
  formatInteractiveLine,
  indentMessage,
} from '../flow/render-model';
import { isSupportsInteractiveTerminal } from '../terminal-environment';
import { describeFailedStages, failedStages } from './report-failures';
import { encodeAnalysisProfile } from './report-schema';
import { writeAnalysisProfile } from './report-storage';

type Graph = AnalysisProfile['graphs'][number];
type Decision = AnalysisProfile['decisions'][number];
type ProfileLine = Pick<FlowRenderFlowLine, 'status' | 'message' | 'depth'>;
const UNKNOWN = '—';

function duration(us: number | null): string {
  return us === null ? 'unavailable' : formatElapsedTime(us / 1000);
}

function info(message: string, depth = 0): ProfileLine {
  return { status: 'info', message, depth };
}

function formatLine(
  { status, message, depth }: ProfileLine,
  isInteractive: boolean,
): string {
  return isInteractive
    ? formatInteractiveLine(status, message, depth, 0)
    : indentMessage(`[${status}] ${message}`, depth);
}

function firstCompleteGraph(
  graphs: readonly Graph[],
  milestone: (graph: Graph) => number | undefined,
): Graph | undefined {
  let first: Graph | undefined;
  let firstAtUs = Infinity;
  for (const graph of graphs) {
    if (graph.purpose !== 'complete') continue;
    const atUs = milestone(graph);
    if (atUs === undefined || atUs >= firstAtUs) continue;
    first = graph;
    firstAtUs = atUs;
  }
  return first;
}

function renderGraphBoundaries(
  profile: AnalysisProfile,
  failures: ReturnType<typeof failedStages>,
): string[] {
  const { graphs, summary } = profile;
  const prepared = summary.firstCompleteGraphPrepared;
  const applied = firstCompleteGraph(graphs, (graph) => graph.applied?.atUs);
  const delivered = firstCompleteGraph(graphs, (graph) => graph.deliveredAtUs);
  const delivery = summary.graphRows.find((row) => row.graph === delivered?.id);
  const rows: string[] = [];
  if (prepared !== null)
    rows.push(
      `Complete graph prepared at ${duration(prepared.atUs)} (${prepared.gate})`,
    );
  else if (failures.every((work) => !work.op.startsWith('graph.prepare.')))
    rows.push('Complete graph preparation not observed');
  rows.push(
    delivery?.requestDeliveryUs == null
      ? 'Complete graph request delivery not observed'
      : `Complete graph request delivered in ${duration(delivery.requestDeliveryUs)}${delivered?.requestGate ? ` (${delivered.requestGate})` : ''}`,
  );
  if (applied?.applied !== undefined)
    rows.push(
      `Complete graph artifacts applied at ${duration(applied.applied.atUs)}`,
    );
  else if (failures.every((work) => work.op !== 'graph.apply.artifacts'))
    rows.push('Complete graph artifact application not observed');
  rows.push(
    summary.firstCompleteReceiptCommittedUs === null
      ? 'Complete materialization receipt commitment not observed'
      : `Complete materialization receipt committed at ${duration(summary.firstCompleteReceiptCommittedUs)}`,
  );
  return rows;
}

function cacheState(profile: AnalysisProfile): string {
  const { cachePolicy } = profile.invocation;
  const { mode } = profile.summary;
  if (mode === 'not-applicable') return 'not applicable';
  if (cachePolicy === 'forced') return 'cold (forced)';
  if (cachePolicy === 'disabled') return 'cold (cache disabled)';
  const snapshot = profile.decisions.filter(
    (decision) => decision.layer === 'analysis-snapshot',
  );
  const lookup = snapshot.find((decision) => decision.stage === 'lookup');
  if (
    (mode === 'cold' || mode === 'unavailable') &&
    lookup?.outcome === 'absent'
  )
    return 'cold (no prior snapshot)';
  if (mode !== 'unavailable') return mode;
  const adoption = snapshot.find((decision) => decision.stage === 'adoption');
  if (adoption?.outcome === 'not-adopted') return 'cold (no snapshot adopted)';
  if (adoption?.outcome === 'adopted' && adoption.origin === 'prior-disk')
    return 'prior snapshot adopted';
  return cachePolicy === 'not-requested' ? 'not requested' : 'unavailable';
}

function causeCodes(
  decision: Decision,
  decisions: ReadonlyMap<string, Decision>,
): string[] {
  const codes = new Set<string>();
  const seen = new Set<string>();
  const pending = [decision];
  for (
    let current = pending.pop();
    current !== undefined;
    current = pending.pop()
  ) {
    if (seen.has(current.id)) continue;
    seen.add(current.id);
    if (current.causes === undefined) continue;
    for (const cause of current.causes) {
      if (cause.code === undefined) {
        const linked = decisions.get(cause.decision);
        if (linked !== undefined) pending.push(linked);
      } else {
        codes.add(cause.code);
      }
    }
  }
  return [...codes];
}

function projectCacheCauses(
  profile: AnalysisProfile,
  decisions: ReadonlyMap<string, Decision>,
) {
  const states = new Map(
    profile.summary.projectRows.map((row) => [row.project, row.state]),
  );
  const causes = new Map<string, Set<string>>();
  for (const { project, decision } of ownedContextCacheDecisions(profile)) {
    const state = states.get(project);
    if (state === undefined || ['skipped', 'covered-by-graph'].includes(state))
      continue;
    let reasons: string[];
    if (decision.outcome === 'adopted') {
      if (state !== 'partial' && state !== 'restored') continue;
      reasons = [decision.origin];
    } else {
      if (
        state === 'restored' ||
        decision.stage === 'publication' ||
        decision.causes === undefined
      )
        continue;
      reasons = causeCodes(decision, decisions);
      if (reasons.length === 0) reasons.push(decision.outcome);
    }
    const existing = causes.get(project);
    if (existing === undefined) causes.set(project, new Set(reasons));
    else for (const reason of reasons) existing.add(reason);
  }
  return causes;
}

function projectLines(
  profile: AnalysisProfile,
  decisions: ReadonlyMap<string, Decision>,
): ProfileLine[] {
  const { coverage, projects, summary } = profile;
  const byId = new Map(projects.map((project) => [project.id, project]));
  const causes = projectCacheCauses(profile, decisions);

  const lines = [info(`Project inventory ${coverage.projectInventory}`)];
  for (const row of summary.projectRows) {
    const project = byId.get(row.project);
    const native = row.programs.find(
      (program) => program.op === 'native-program-create',
    );
    const programs =
      coverage.workDetail === 'partial'
        ? 'unavailable'
        : native === undefined
          ? UNKNOWN
          : `${native.attempts}/${native.created}`;
    const reasons = causes.get(row.project);
    const cause =
      reasons === undefined
        ? row.state === 'covered-by-graph'
          ? 'complete graph'
          : UNKNOWN
        : [...reasons]
            .sort((left, right) => left.localeCompare(right))
            .join(', ');
    lines.push(
      info(
        `${project?.path ?? row.project} · ${project?.executionChecker ?? UNKNOWN} · ${row.state}`,
        1,
      ),
      info(
        `Observed work union ${duration(row.workUnionUs)} · Native Programs attempted/created ${programs} · Cache cause ${cause}`,
        2,
      ),
    );
  }
  return lines;
}

function detailLines(
  profile: AnalysisProfile,
  decisions: ReadonlyMap<string, Decision>,
): ProfileLine[] {
  const contexts = new Map(
    profile.contexts.map((context) => [context.id, context]),
  );
  const rows = [info('Context work unions')];
  for (const row of profile.summary.contextRows) {
    const context = contexts.get(row.context);
    rows.push(
      info(
        `${row.context} · ${context?.provider ?? UNKNOWN} · ${row.state} · ${duration(row.workUnionUs)}`,
        1,
      ),
    );
  }
  const counts = new Map<string, number>();
  for (const item of profile.work)
    counts.set(item.op, (counts.get(item.op) ?? 0) + 1);
  rows.push(info('Recorded operations'));
  for (const [op, count] of counts) rows.push(info(`${op} · ${count}`, 1));

  const codes = new Set<string>();
  for (const id of profile.summary.basis) {
    const decision = decisions.get(id);
    if (decision !== undefined) {
      for (const code of causeCodes(decision, decisions)) codes.add(code);
    }
  }
  rows.push(
    info(`Cache classification causes ${[...codes].join(', ') || UNKNOWN}`),
  );
  return rows;
}

function profileLines(
  profile: AnalysisProfile,
  isVerbose: boolean,
  failureDetail: ((work: string) => unknown) | undefined,
): ProfileLine[] {
  const { coverage, invocation } = profile;
  const decisions = new Map(
    profile.decisions.map((decision) => [decision.id, decision]),
  );
  const failures = failedStages(profile);
  const rows: ProfileLine[] = [
    {
      status: invocation.result === 'passed' ? 'pass' : 'fail',
      message: `Command (${duration(invocation.commandInvocationUs)} CLI wall time)`,
      depth: 0,
    },
    info(`Analysis cache: ${cacheState(profile)}`, 1),
  ];
  for (const failure of describeFailedStages(
    profile,
    failures,
    failureDetail,
  )) {
    rows.push(
      {
        status: 'fail',
        message: `${failure.stage} failed after ${duration(failure.durationUs)}`,
        depth: 1,
      },
      ...failure.reasons.map((reason) => info(reason, 2)),
    );
  }
  rows.push(
    ...renderGraphBoundaries(profile, failures).map((message) =>
      info(message, 1),
    ),
    info(
      `Observed inline profile overhead ${duration(invocation.profileOverhead.inlineObservedUnionUs)} (timed profile.* spans only)`,
      1,
    ),
    info(
      'Per-observation bookkeeping and final report generation and output are outside this measurement.',
      2,
    ),
    ...projectLines(profile, decisions),
  );
  if (coverage.workDetail === 'partial')
    rows.push(info('Work detail partial · counts include retained work only'));
  if (coverage.detailsOmitted > 0)
    rows.push(info(`${coverage.detailsOmitted} observations omitted`));
  if (isVerbose) rows.push(...detailLines(profile, decisions));
  return rows;
}

async function writeStderr(lines: readonly string[]): Promise<void> {
  await new Promise<void>((resolve) => {
    const stderr = process.stderr;
    const onError = () => resolve();
    stderr.once('error', onError);
    try {
      stderr.write(`${lines.join('\n')}\n`, () => {
        // A writable can emit its error after invoking the write callback.
        setImmediate(() => stderr.off('error', onError));
        resolve();
      });
    } catch {
      stderr.off('error', onError);
      resolve();
    }
  });
}

export async function emitAnalysisProfile(options: {
  cwd: string;
  namespace: LiminaArtifactNamespace | undefined;
  outputDirectory: string | undefined;
  profile: AnalysisProfile;
  stderr: 'silent' | 'summary' | 'verbose';
  failureDetail?: (work: string) => unknown;
}): Promise<void> {
  const { profile, stderr } = options;
  const isInteractive =
    stderr !== 'silent' &&
    isSupportsInteractiveTerminal(process.env, process.stderr);
  let content: string;
  try {
    content = encodeAnalysisProfile(profile);
  } catch {
    if (stderr !== 'silent')
      await writeStderr([
        formatLine(
          {
            status: 'warn',
            depth: 0,
            message: 'Limina could not encode the analysis profile.',
          },
          isInteractive,
        ),
      ]);
    return;
  }

  let destination: string | undefined;
  try {
    await writeAnalysisProfile({
      cwd: options.cwd,
      namespace: options.namespace,
      outputDirectory: options.outputDirectory,
      invocationId: profile.invocation.id,
      content,
    });
    const file = `${profile.invocation.id}.json`;
    destination =
      options.outputDirectory === undefined ? `.limina/profiles/${file}` : file;
  } catch {
    // Report storage is best effort and reported alongside the profile.
  }
  if (stderr === 'silent') return;
  const rows = profileLines(
    profile,
    stderr === 'verbose',
    options.failureDetail,
  );
  if (destination === undefined)
    rows.push({
      status: 'warn',
      depth: 0,
      message: 'Limina could not write the analysis profile.',
    });
  const title = `Limina Analysis Profile ${profile.invocation.id}`;
  const outro =
    destination === undefined ? 'End of profile' : `Report ${destination}`;
  await writeStderr([
    isInteractive ? `┌  ${title}` : `[start] ${title}`,
    ...rows.map((row) => formatLine(row, isInteractive)),
    isInteractive ? `└  ${outro}` : `[done] ${outro}`,
  ]);
}
