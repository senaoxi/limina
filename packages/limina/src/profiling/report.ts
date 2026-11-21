import type { AnalysisProfile } from '../application/analysis/observability';
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

function renderProjects(
  profile: AnalysisProfile,
  decisions: ReadonlyMap<string, Decision>,
): string[] {
  const { coverage, projects, contexts, work, summary } = profile;
  const byId = new Map(projects.map((project) => [project.id, project]));
  const pathToId = new Map(projects.map(({ id, path }) => [path, id]));
  const contextOwners = new Map(
    contexts.map(({ id, project }) => [id, project]),
  );
  const workScopes = new Map(work.map(({ id, scope }) => [id, scope]));
  const projectDecisions = new Map<string, Decision>();
  for (const decision of decisions.values()) {
    if (!decision.causes && decision.outcome !== 'adopted') continue;
    const scope = workScopes.get(decision.work);
    const scopedProject =
      scope?.[0] === 'project'
        ? scope[1]
        : scope?.[0] === 'context'
          ? contextOwners.get(scope[1])
          : undefined;
    const project =
      decision.subject === undefined
        ? scopedProject
        : pathToId.get(decision.subject);
    if (project !== undefined) projectDecisions.set(project, decision);
  }

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
    const decision = projectDecisions.get(row.project);
    let cause = row.state === 'covered-by-graph' ? 'complete graph' : UNKNOWN;
    if (decision !== undefined) {
      cause =
        decision.outcome === 'adopted'
          ? decision.origin
          : causeCodes(decision, decisions).join(', ') || decision.outcome;
    }
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
