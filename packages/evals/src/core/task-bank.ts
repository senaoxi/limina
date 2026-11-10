import { type FrozenTask, taskCatalog } from './experiment.ts';
import { contentIdentity } from './identity.ts';
import { assertDigest } from './model-profile.ts';
import type { TaskSpec } from './task.ts';

export interface BankTask extends FrozenTask {
  scenarioId: string;
  fixtureDigest: string;
  promptDigest: string;
  graderDigest: string;
  role: 'main' | 'negative-control';
}
export interface TaskBankRevision {
  schemaVersion: 1;
  revision: 'v1' | 'v2' | 'v2.1';
  id: string;
  tasks: BankTask[];
}
export type BankRevision = TaskBankRevision['revision'];
export function isBankRevision(value: unknown): value is BankRevision {
  return typeof value === 'string' && ['v1', 'v2', 'v2.1'].includes(value);
}
export function createTaskBank(
  revision: TaskBankRevision['revision'],
  entries: { task: TaskSpec; identity: FrozenTask }[],
): TaskBankRevision {
  if (!isBankRevision(revision) || entries.length !== 26)
    throw new Error('A bank requires the complete 26-task inventory');
  const tasks = entries
    .map(({ task, identity }) => {
      if (
        identity.specDigest !== contentIdentity(task) ||
        taskCatalog.filter(
          (t) =>
            t.id === task.id &&
            t.domain === task.domain &&
            t.split === task.split,
        ).length !== 1 ||
        (revision === 'v1'
          ? task.bankRevision !== undefined
          : task.bankRevision !== revision)
      )
        throw new Error('Task belongs to another bank or split');
      return {
        ...identity,
        scenarioId: `${revision}:${task.id}`,
        fixtureDigest: task.fixtureDigest,
        promptDigest: contentIdentity(task.prompt),
        graderDigest: task.gradingContract.graderDigest,
        role:
          task.domain === 'negative-control'
            ? ('negative-control' as const)
            : ('main' as const),
      };
    })
    .toSorted((a, b) => a.id.localeCompare(b.id));
  return freezeBank(revision, tasks);
}
function freezeBank(
  revision: TaskBankRevision['revision'],
  tasks: BankTask[],
): TaskBankRevision {
  if (
    tasks.length !== 26 ||
    taskCatalog.some(
      (t) =>
        tasks.filter(
          (x) => x.id === t.id && x.domain === t.domain && x.split === t.split,
        ).length !== 1,
    )
  )
    throw new Error('Invalid task bank inventory');
  for (const t of tasks) {
    for (const d of [
      t.specDigest,
      t.executionDigest,
      t.gradingDigest,
      t.fixtureDigest,
      t.promptDigest,
      t.graderDigest,
    ])
      assertDigest(d);
    if (
      t.scenarioId !== `${revision}:${t.id}` ||
      t.role !== (t.domain === 'negative-control' ? 'negative-control' : 'main')
    )
      throw new Error('Invalid scenario role');
  }
  const body = {
    schemaVersion: 1 as const,
    revision,
    tasks: structuredClone(tasks),
  };
  return { ...body, id: contentIdentity(body) };
}
export function verifyTaskBank(bank: TaskBankRevision): void {
  if (
    bank.schemaVersion !== 1 ||
    !isBankRevision(bank.revision) ||
    contentIdentity(bank) !==
      contentIdentity(freezeBank(bank.revision, bank.tasks))
  )
    throw new Error('Task bank identity changed');
}
