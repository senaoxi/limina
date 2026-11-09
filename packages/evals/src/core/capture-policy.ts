import {
  assertRelativePath,
  captureSnapshot,
  type Snapshot,
  verifySnapshot,
} from './snapshot.ts';
import type { TaskSpec } from './task.ts';

const isWithin = (file: string, root: string) =>
  file === root || file.startsWith(`${root}/`);
const hasIntersection = (a: string, b: string) =>
  isWithin(a, b) || isWithin(b, a);
const sorted = (values: string[]) =>
  values.toSorted((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));

export function captureRoots(task: TaskSpec): string[] {
  if (
    task.version !== 2 ||
    !task.capturePolicy ||
    !Array.isArray(task.capturePolicy.excludedRoots) ||
    !Array.isArray(task.capturePolicy.requiredRoots)
  )
    throw new Error('Task requires an explicit versioned capture policy');
  const excluded = sorted(task.capturePolicy.excludedRoots);
  const required = [
    '.agents',
    ...task.capturePolicy.requiredRoots,
    ...task.mutationPolicy.protectedRoots,
    ...task.mutationPolicy.rules.map((rule) => rule.path),
    ...task.dependencyPolicy.inputs.map((input) => input.path),
  ];
  for (const root of [...excluded, ...required]) assertRelativePath(root);
  if (new Set(excluded).size !== excluded.length)
    throw new Error('Duplicate capture exclusion');
  for (const root of excluded) {
    if (
      !['.eval-tmp', '.limina', 'node_modules'].includes(root) &&
      !root.endsWith('/.limina') &&
      !root.endsWith('/node_modules')
    )
      throw new Error(
        'Only declared runtime caches or dependency directories may be excluded',
      );
    if (required.some((file) => hasIntersection(file, root)))
      throw new Error('Capture exclusion overlaps required task state');
    if (
      excluded.some((other) => other !== root && hasIntersection(other, root))
    )
      throw new Error('Overlapping capture exclusions');
  }
  return excluded;
}

export function assertFixtureCaptureScope(
  task: TaskSpec,
  fixture: Snapshot,
): void {
  verifySnapshot(fixture);
  if (fixture.stage !== 'F0' || fixture.excludedRoots.length > 0)
    throw new Error('Original fixture must be captured without exclusions');
  const roots = captureRoots(task);
  if (
    fixture.entries.some((entry) =>
      roots.some((root) => isWithin(entry.path, root)),
    )
  )
    throw new Error('Capture policy would omit frozen fixture input');
}

export function assertTaskCaptureScope(
  task: TaskSpec,
  snapshot: Snapshot,
): void {
  if (
    JSON.stringify(captureRoots(task)) !==
    JSON.stringify(snapshot.excludedRoots)
  )
    throw new Error('Snapshot capture policy differs from frozen TaskSpec');
}

export async function captureTaskSnapshot(
  root: string,
  stage: 'S0' | 'S1',
  task: TaskSpec,
): Promise<Snapshot> {
  return captureSnapshot(root, stage, { excludedRoots: captureRoots(task) });
}
