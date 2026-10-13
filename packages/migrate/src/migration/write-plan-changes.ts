import { parse } from 'jsonc-parser';
import { resolveReferencePath } from 'limina/internal/core/tsconfig/actions';
import { isPlainRecord } from 'limina/internal/utils/values';
import type { MigrationRecord } from './declarations';
import type { FrozenMigrationPlan } from './planner';
import type { MigrationWritePlanItem } from './transaction';

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
export function operationActions(
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
