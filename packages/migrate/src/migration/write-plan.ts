import { parse } from 'jsonc-parser';
import { resolveReferencePath } from 'limina/internal/core/tsconfig/actions';
import { MigrationLogger } from 'limina/internal/logger';
import { compareCodeUnits } from 'limina/internal/utils/collections';
import { isPlainRecord } from 'limina/internal/utils/values';
import path from 'pathe';
import type { MigrationRecord } from './declarations';
import type { FrozenMigrationPlan } from './planner';
import type { MigrationWritePlanItem } from './transaction';
import type { RunMigrationOptions } from './types';

interface PatchView {
  item: MigrationWritePlanItem;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  records: readonly MigrationRecord[];
}
function metadata(object: Record<string, unknown>): Record<string, unknown> {
  return isPlainRecord(object.liminaOptions) ? object.liminaOptions : {};
}
function declarations(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(isPlainRecord).map((item) => String(item.path))
    : [];
}
function removed(before: string[], after: string[]): string[] {
  const remaining = [...after];
  return before.filter((entry) => {
    const index = remaining.indexOf(entry);
    if (index === -1) return true;
    remaining.splice(index, 1);
    return false;
  });
}
function isChanged(before: unknown, after: unknown): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}
function describePaths(paths: string[], label: string): string[] {
  return paths.length > 0
    ? [`${label}: ${paths.length} (${paths.join(', ')})`]
    : [];
}
function schemaActions(view: PatchView): string[] {
  return isChanged(view.before.$schema, view.after.$schema)
    ? [`schema: ${String(view.after.$schema)}`]
    : [];
}
function isRecordFor(
  record: MigrationRecord,
  view: PatchView,
  kind: string,
): boolean {
  return record.configPath === view.item.configPath && record.kind === kind;
}
function expansionMembers(details: unknown): string[] {
  if (!isPlainRecord(details)) return [];
  return Array.isArray(details.members) ? details.members.map(String) : [];
}
function convertedTargets(
  view: PatchView,
  nativeRemoved: string[],
): Set<string> {
  const targets = new Set(
    nativeRemoved.map((value) =>
      resolveReferencePath(view.item.configPath, value),
    ),
  );
  const expansions = view.records.filter(
    (record) =>
      isRecordFor(record, view, 'native-solution-expanded') &&
      nativeRemoved.includes(String(record.original)),
  );
  for (const record of expansions)
    for (const member of expansionMembers(record.details)) targets.add(member);
  return targets;
}
function outsideReferences(view: PatchView, nativeRemoved: string[]): string[] {
  const outside = view.records.filter(
    (record) =>
      isRecordFor(record, view, 'removed-native-reference') &&
      record.message === 'outside activated config topology',
  );
  return nativeRemoved.filter((value) =>
    outside.some((record) => String(record.original) === value),
  );
}
function nativeActions(view: PatchView): string[] {
  const before = declarations(view.before.references);
  const after = declarations(view.after.references);
  const nativeRemoved = removed(before, after);
  return [
    ...describePaths(nativeRemoved, 'native references removed/converted'),
    ...describePaths(
      removed(after, before),
      'solution membership references added',
    ),
    ...describePaths(
      outsideReferences(view, nativeRemoved),
      'outside-scope references removed',
    ),
  ];
}
function reusedImplicit(
  view: PatchView,
  before: string[],
  after: string[],
): string[] {
  const nativeRemoved = removed(
    declarations(view.before.references),
    declarations(view.after.references),
  );
  const targets = convertedTargets(view, nativeRemoved);
  const reused = new Set(
    after.filter(
      (value) =>
        before.includes(value) &&
        targets.has(resolveReferencePath(view.item.configPath, value)),
    ),
  );
  return reused.size > 0
    ? [`implicitRefs reused: ${reused.size}; existing reasons preserved`]
    : [];
}
function implicitActions(view: PatchView): string[] {
  const before = declarations(metadata(view.before).implicitRefs);
  const after = declarations(metadata(view.after).implicitRefs);
  return [
    ...describePaths(removed(after, before), 'implicitRefs added'),
    ...describePaths(removed(before, after), 'implicitRefs removed'),
    ...reusedImplicit(view, before, after),
  ];
}
function outputActions(view: PatchView): string[] {
  const before = metadata(view.before).outputs;
  const after = metadata(view.after).outputs;
  return isChanged(before, after)
    ? [`outputs: ${JSON.stringify(after) ?? 'removed'}`]
    : [];
}
function sourceActions(
  item: MigrationWritePlanItem,
  records: readonly MigrationRecord[],
): string[] {
  const view: PatchView = {
    item,
    records,
    before: parse(item.originalContent ?? '{}'),
    after: parse(item.nextContent),
  };
  return [
    ...schemaActions(view),
    ...nativeActions(view),
    ...implicitActions(view),
    ...outputActions(view),
  ];
}
function operationActions(
  item: MigrationWritePlanItem,
  plan: FrozenMigrationPlan,
): string[] {
  const exclusion = plan.records.find(
    (record) =>
      record.kind === 'exclusions-planned' &&
      record.configPath === item.configPath,
  );
  return exclusion
    ? [
        item.operation === 'create'
          ? 'Create minimal Limina config: isolation requires persisted scope.regions.exclude'
          : 'Update static Limina config: scope.regions.exclude',
        `exact exclusions: ${JSON.stringify(exclusion.details)}`,
      ]
    : sourceActions(item, plan.records);
}

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
