import { stripVTControlCharacters } from 'node:util';
import type { AnalysisProfile } from '../application/analysis/observability';

type Work = AnalysisProfile['work'][number];
type FailedWork = Extract<Work, { reason: string; time: unknown }>;

const stageNames = new Map([
  ['cli.config-load', 'Configuration loading'],
  ['graph.prepare.core', 'Graph preparation (core)'],
  ['graph.prepare.preflight', 'Graph preparation (preflight)'],
  ['graph.apply.artifacts', 'Graph artifact application'],
  ['checker-process', 'Checker process'],
  ['graph.attempt', 'Graph analysis attempt'],
  ['graph.request', 'Graph preparation request'],
  ['graph.materialize', 'Graph materialization'],
  ['graph.materialize.request', 'Graph materialization request'],
]);
const stageOrder = stageNames.keys().toArray();

function isTaskWork(work: Work): boolean {
  return (
    work.op === 'execution.task-runner' ||
    work.op === 'execution.standalone-action'
  );
}

function failedOwner(
  work: Work,
  workById: ReadonlyMap<string, Work>,
): string | undefined {
  for (
    let current: Work | undefined = work;
    current !== undefined;
    current = workById.get(current.parent ?? '')
  ) {
    if (current.end === 'superseded' || current.end === 'cancelled')
      return undefined;
    if (isTaskWork(current) || current.op === 'command')
      return current.end === 'failed' ? current.id : undefined;
  }
  return undefined;
}

function priority(work: Work): number {
  const index = stageOrder.indexOf(work.op);
  return index === -1 ? stageOrder.length : index;
}

export function failedStages(profile: AnalysisProfile): FailedWork[] {
  if (profile.invocation.result === 'passed') return [];
  const workById = new Map(profile.work.map((work) => [work.id, work]));
  const stages = new Map<string, FailedWork>();
  for (const work of profile.work) {
    if (
      work.end !== 'failed' ||
      (!stageNames.has(work.op) && !isTaskWork(work))
    )
      continue;
    const owner = failedOwner(work, workById);
    if (owner === undefined) continue;
    const current = stages.get(owner);
    if (current === undefined || priority(work) < priority(current))
      stages.set(owner, work);
  }
  if (stages.size > 0) return stages.values().toArray();
  const command = profile.work.find((work) => work.op === 'command');
  return command?.end === 'failed' ? [command] : [];
}

function reasonLines(detail: unknown, fallback: string): string[] {
  const message = detail instanceof Error ? detail.message : detail;
  const text =
    typeof message === 'string' ? stripVTControlCharacters(message).trim() : '';
  const [first, ...rest] = (text || stripVTControlCharacters(fallback))
    .split(/\r?\n/u)
    .map((line) => line.replaceAll(/\p{Cc}/gu, ' '));
  return [`Reason: ${first}`, ...rest];
}

export function describeFailedStages(
  profile: AnalysisProfile,
  failures: readonly FailedWork[],
  failureDetail: ((work: string) => unknown) | undefined,
): { stage: string; durationUs: number; reasons: string[] }[] {
  return failures.map((work) => {
    const [kind, id] = work.scope;
    const stage =
      stageNames.get(work.op) ??
      (kind === 'task'
        ? profile.tasks.find((task) => task.id === id)?.name
        : undefined) ??
      'Command';
    return {
      stage,
      durationUs: work.time[1] - work.time[0],
      reasons: reasonLines(failureDetail?.(work.id), work.reason),
    };
  });
}
