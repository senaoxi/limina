import { MigrationLogger } from 'limina/internal/logger';
import { compareCodeUnits } from 'limina/internal/utils/collections';
import path from 'pathe';
import type { FrozenMigrationPlan } from './planner';
import type { MigrationWritePlanItem } from './transaction';
import type { RunMigrationOptions } from './types';
import { operationActions } from './write-plan-changes';

export interface WritePlanPreview {
  operations: {
    operation: 'create' | 'update';
    path: string;
    actions: string[];
  }[];
  unchanged: number;
  blocked: { path: string; reason: string }[];
  isolated: { path: string; reason: string }[];
  reportPath: string;
}
function effectiveItems(plan: FrozenMigrationPlan): MigrationWritePlanItem[] {
  const items = new Map<string, MigrationWritePlanItem>();
  const effective = plan.groups
    .flat()
    .filter(
      (item) =>
        item.status === 'modified' && item.originalContent !== item.nextContent,
    );
  for (const item of effective) {
    if (items.has(item.configPath))
      throw new Error(`Duplicate frozen write target: ${item.configPath}`);
    items.set(item.configPath, item);
  }
  return items.values().toArray();
}
function diagnosticItems(plan: FrozenMigrationPlan, kinds: readonly string[]) {
  return plan.records
    .filter((record) => kinds.includes(record.kind))
    .map((record) => ({
      path: record.configPath,
      reason: record.message ?? record.kind,
    }));
}
function sourceModifiedCount(
  items: MigrationWritePlanItem[],
  plan: FrozenMigrationPlan,
): number {
  return items.filter((item) =>
    plan.records.every(
      (record) =>
        record.kind !== 'exclusions-planned' ||
        record.configPath !== item.configPath,
    ),
  ).length;
}
/**
Only effective frozen patches supply the write set. No discovery or planning runs here.
*/
export function createWritePlanPreview(
  plan: FrozenMigrationPlan,
  rootDirectory: string,
): WritePlanPreview {
  const items = effectiveItems(plan);
  const isolated = diagnosticItems(plan, ['isolated']);
  const blocked = diagnosticItems(plan, [
    'patch-unavailable',
    'normalization-blocked',
    'ambiguous-input',
    'exclusions-not-persisted',
  ]);
  return {
    operations: items
      .sort((a, b) => compareCodeUnits(a.configPath, b.configPath))
      .map((item) => ({
        operation: item.operation === 'create' ? 'create' : 'update',
        path: item.configPath,
        actions: operationActions(item, plan),
      })),
    unchanged: Math.max(
      0,
      plan.targetCount -
        sourceModifiedCount(items, plan) -
        new Set([...isolated, ...blocked].map((item) => item.path)).size,
    ),
    blocked,
    isolated,
    reportPath: path.join(rootDirectory, '.limina/migration/latest.json'),
  };
}
function previewNotice(isDryRun: boolean | undefined): string[] {
  return isDryRun
    ? [
        '  Preview: disk verification and all migration-controlled writes are disabled.',
        '  Executable user configuration and third-party entrypoints are not a JavaScript side-effect sandbox.',
      ]
    : [];
}
export function showWritePlan(
  plan: FrozenMigrationPlan,
  rootDirectory: string,
  options: RunMigrationOptions,
): WritePlanPreview {
  const preview = createWritePlanPreview(plan, rootDirectory);
  const lines = [
    'Write Plan Summary (planned)',
    `  create: ${preview.operations.filter((item) => item.operation === 'create').length}; update: ${preview.operations.filter((item) => item.operation === 'update').length}; total planned files: ${preview.operations.length}`,
    ...preview.operations.flatMap((item) => [
      `  ${item.operation}: ${path.relative(rootDirectory, item.path)}`,
      ...item.actions.map((action) => `    ${action}`),
    ]),
    `  unchanged: ${preview.unchanged}; blocked: ${preview.blocked.length}; isolated unchanged: ${preview.isolated.length}`,
    ...preview.blocked.map(
      (item) =>
        `  blocked: ${path.relative(rootDirectory, item.path)} — ${item.reason}`,
    ),
    ...preview.isolated.map(
      (item) =>
        `  isolated, preserved: ${path.relative(rootDirectory, item.path)} — ${item.reason}`,
    ),
    `  auxiliary audit (Applied only): ${preview.reportPath}`,
    '  Git, physical identity, dirty-worktree and hardlink write checks: pending; decisions may shrink this plan.',
    ...previewNotice(options.dryRun),
  ];
  writePlanOutput(options, `${lines.join('\n')}\n`);
  return preview;
}
function writePlanOutput(options: RunMigrationOptions, output: string): void {
  if (options.flow) options.flow.writeOutput(output);
  else MigrationLogger.info(output);
}
export function showWriteDecisions(
  options: RunMigrationOptions,
  messages: readonly string[],
): void {
  if (messages.length === 0) return;
  writePlanOutput(
    options,
    `Write decisions\n${messages.map((message) => `  ${message}`).join('\n')}\n`,
  );
}
