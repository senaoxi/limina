import type { AnalysisProfile } from '../application/analysis/observability';
import { ownedContextCacheDecisions } from '../application/analysis/observability-summary';
import type { LiminaArtifactNamespace } from '../domain/artifacts/namespace';
import { encodeAnalysisProfile } from './report-schema';
import { writeAnalysisProfile } from './report-storage';

type Graph = AnalysisProfile['graphs'][number];
type Decision = AnalysisProfile['decisions'][number];
const UNKNOWN = '—';

function duration(us: number | null): string {
  return us === null ? 'unavailable' : `${(us / 1000).toFixed(1)} ms`;
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

function renderGraphBoundaries(profile: AnalysisProfile): string[] {
  const { graphs, summary } = profile;
  const prepared = summary.firstCompleteGraphPrepared;
  const applied = firstCompleteGraph(graphs, (graph) => graph.applied?.atUs);
  const delivered = firstCompleteGraph(graphs, (graph) => graph.deliveredAtUs);
  const delivery = summary.graphRows.find((row) => row.graph === delivered?.id);
  return [
    `Complete graph prepared at ${duration(prepared?.atUs ?? null)}${prepared ? ` (${prepared.gate})` : ''}`,
    `Complete graph request delivery ${duration(delivery?.requestDeliveryUs ?? null)}${delivered?.requestGate ? ` (${delivered.requestGate})` : ''}`,
    `Complete graph artifacts applied at ${duration(applied?.applied?.atUs ?? null)}`,
    `Complete materialization receipt committed at ${duration(summary.firstCompleteReceiptCommittedUs)}`,
  ];
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

function renderProjects(
  profile: AnalysisProfile,
  decisions: ReadonlyMap<string, Decision>,
): string[] {
  const { coverage, projects, summary } = profile;
  const byId = new Map(projects.map((project) => [project.id, project]));
  const causes = projectCacheCauses(profile, decisions);

  const lines = [`Project inventory ${coverage.projectInventory}`];
  if (summary.projectRows.length > 0) {
    lines.push(
      '  Project  Checker  State  Observed work union  Native Programs attempted/created  Cache cause',
    );
  }
  for (const row of summary.projectRows) {
    const project = byId.get(row.project);
    const native = row.programs.find(
      (program) => program.op === 'native-program-create',
    );
    const programs =
      native === undefined ? UNKNOWN : `${native.attempts}/${native.created}`;
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
      `  ${project?.path ?? row.project}  ${project?.executionChecker ?? UNKNOWN}  ${row.state}  ${duration(row.workUnionUs)}  ${programs}  ${cause}`,
    );
  }
  return lines;
}

function renderDetails(
  profile: AnalysisProfile,
  decisions: ReadonlyMap<string, Decision>,
): string[] {
  const contexts = new Map(
    profile.contexts.map((context) => [context.id, context]),
  );
  const rows = ['Context work unions'];
  for (const row of profile.summary.contextRows) {
    const context = contexts.get(row.context);
    rows.push(
      `  ${row.context}  ${context?.provider ?? UNKNOWN}  ${row.state}  ${duration(row.workUnionUs)}`,
    );
  }
  const counts = new Map<string, number>();
  for (const item of profile.work)
    counts.set(item.op, (counts.get(item.op) ?? 0) + 1);
  rows.push('Recorded operations');
  for (const [op, count] of counts) rows.push(`  ${op}  ${count}`);

  const codes = new Set<string>();
  for (const id of profile.summary.basis) {
    const decision = decisions.get(id);
    if (decision !== undefined) {
      for (const code of causeCodes(decision, decisions)) codes.add(code);
    }
  }
  rows.push(`Cache classification causes ${[...codes].join(', ') || UNKNOWN}`);
  return rows;
}

function renderProfile(profile: AnalysisProfile, isVerbose: boolean): string[] {
  const { coverage, invocation, summary } = profile;
  const decisions = new Map(
    profile.decisions.map((decision) => [decision.id, decision]),
  );
  const rows = [
    `Limina Analysis Profile ${invocation.id}`,
    `${invocation.result} · ${summary.mode} · ${duration(invocation.commandInvocationUs)} CLI wall time`,
    `Observed inline profile overhead ${duration(invocation.profileOverhead.inlineObservedUnionUs)}`,
    ...renderGraphBoundaries(profile),
    ...renderProjects(profile, decisions),
  ];
  if (coverage.detailsOmitted > 0)
    rows.push(`${coverage.detailsOmitted} observations omitted`);
  if (isVerbose) rows.push(...renderDetails(profile, decisions));
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
}): Promise<void> {
  const { profile, stderr } = options;
  let content: string;
  try {
    content = encodeAnalysisProfile(profile);
  } catch {
    if (stderr !== 'silent')
      await writeStderr(['Limina could not encode the analysis profile.']);
    return;
  }

  let destination: string;
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
    destination = 'Limina could not write the analysis profile.';
  }
  if (stderr !== 'silent')
    await writeStderr([
      ...renderProfile(profile, stderr === 'verbose'),
      destination,
    ]);
}
