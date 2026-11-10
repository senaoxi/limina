import { chmod, lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertFixtureCaptureScope } from './capture-policy.ts';
import { type MutationDecision, validateMutations } from './mutation.ts';
import {
  assertRelativePath,
  captureSnapshot,
  type Snapshot,
  type SnapshotEntry,
  verifySnapshot,
} from './snapshot.ts';
import type { TaskSpec } from './task.ts';

function assertMaterializable(snapshot: Snapshot): void {
  verifySnapshot(snapshot);
  const entries = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
  for (const entry of snapshot.entries) {
    // Installation symlinks are constructed from the admitted closure later.
    // Project symlinks are not silently dereferenced or skipped.
    if (entry.kind === 'symlink' || (entry.mode & 0o7000) !== 0)
      throw new Error('Unsupported verifier input type or mode');
    const parts = entry.path.split('/');
    for (let length = 1; length < parts.length; length++) {
      if (entries.get(parts.slice(0, length).join('/'))?.kind !== 'directory')
        throw new Error('Snapshot has a missing or non-directory ancestor');
    }
  }
}

async function writeEntries(
  root: string,
  entries: SnapshotEntry[],
): Promise<void> {
  const directories = entries
    .filter((entry) => entry.kind === 'directory')
    .toSorted((a, b) => a.path.split('/').length - b.path.split('/').length);
  for (const entry of directories)
    await mkdir(path.join(root, entry.path), { recursive: false, mode: 0o700 });
  for (const entry of entries) {
    if (entry.kind !== 'file') continue;
    await writeFile(
      path.join(root, entry.path),
      Buffer.from(entry.content, 'base64'),
      { flag: 'wx', mode: 0o600 },
    );
    await chmod(path.join(root, entry.path), entry.mode);
  }
  for (const entry of directories.toReversed())
    await chmod(path.join(root, entry.path), entry.mode);
}

/**
Materialize frozen bytes only. This never installs dependencies or runs scripts.
*/
export async function materializeSnapshot(
  snapshot: Snapshot,
  destination: string,
): Promise<void> {
  assertMaterializable(snapshot);
  if (
    !path.isAbsolute(destination) ||
    (await realpath(path.dirname(destination))) !== path.dirname(destination)
  )
    throw new Error(
      'Destination parent must be controller-owned and canonical',
    );
  await mkdir(destination, { mode: 0o700 });
  await writeEntries(destination, snapshot.entries);
}

const admittedProjects = new WeakSet<object>();
export interface ReconstructedProject {
  readonly directory: string;
  readonly digest: string;
  readonly excludedRoots: readonly string[];
  readonly dependencyClosureDigest: string;
}

export async function verifyReconstructedProject(
  project: ReconstructedProject,
): Promise<void> {
  if (!admittedProjects.has(project))
    throw new Error('Project has not passed reconstruction');
  const snapshot = await captureSnapshot(project.directory, 'S1', {
    excludedRoots: [...project.excludedRoots],
  });
  if (snapshot.status !== 'complete' || snapshot.digest !== project.digest)
    throw new Error('Reconstructed project changed before verifier transfer');
}

async function replayChanges(
  destination: string,
  changes: Extract<MutationDecision, { status: 'accepted' }>['changes'],
): Promise<void> {
  // Apply deletions deepest first; a rename is an explicit deletion plus addition.
  const deleted = changes
    .filter((change) => !change.after)
    .toSorted((a, b) => b.path.split('/').length - a.path.split('/').length);
  for (const change of deleted) {
    assertRelativePath(change.path);
    await rm(path.join(destination, change.path), {
      recursive: change.before?.kind === 'directory',
    });
  }
  const changed = changes.filter((change) => change.after);
  const newEntries: SnapshotEntry[] = [];
  for (const change of changed) {
    if (!change.after) continue;
    if (!change.before) newEntries.push(change.after);
    else if (change.after.kind === 'file') {
      await writeFile(
        path.join(destination, change.path),
        Buffer.from(change.after.content, 'base64'),
        { flag: 'w' },
      );
      await chmod(path.join(destination, change.path), change.after.mode);
    }
  }
  await writeEntries(destination, newEntries);
  for (const change of changed) {
    if (change.before && change.after?.kind === 'directory')
      await chmod(path.join(destination, change.path), change.after.mode);
  }
}

/**
Validation precedes even trusted setup. The callback is controller code that
prepares S0 after frozen F0 materialization, never an Agent-supplied hook.
*/
export async function reconstructForVerifier(input: {
  task: TaskSpec;
  fixture: Snapshot;
  start: Snapshot;
  final: Snapshot;
  destination: string;
  prepareStart: (destination: string) => Promise<void>;
}): Promise<{
  decision: MutationDecision;
  project: ReconstructedProject | null;
}> {
  const decision = validateMutations(input.task, input.start, input.final);
  if (decision.status !== 'accepted') return { decision, project: null };
  assertFixtureCaptureScope(input.task, input.fixture);
  if (
    input.fixture.stage !== 'F0' ||
    input.fixture.digest !== input.task.fixtureDigest
  )
    throw new Error('Fixture differs from frozen TaskSpec');
  assertMaterializable(input.fixture);
  assertMaterializable(input.start);
  assertMaterializable(input.final);
  // Never let a trusted callback accidentally overwrite an existing workspace.
  let isExisting = false;
  try {
    await lstat(input.destination);
    isExisting = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (isExisting) throw new Error('Verifier destination already exists');
  await materializeSnapshot(input.fixture, input.destination);
  await input.prepareStart(input.destination);
  if ((await realpath(input.destination)) !== input.destination)
    throw new Error('Verifier root is not canonical');
  const rebuilt = await captureSnapshot(input.destination, 'S0', {
    excludedRoots: input.start.excludedRoots,
  });
  if (rebuilt.status !== 'complete' || rebuilt.digest !== input.start.digest)
    throw new Error('Rebuilt S0 differs from frozen Agent start');
  await replayChanges(input.destination, decision.changes);
  const final = await captureSnapshot(input.destination, 'S1', {
    excludedRoots: input.final.excludedRoots,
  });
  if (final.status !== 'complete' || final.digest !== input.final.digest)
    throw new Error('Replayed project does not match validated S1');
  const project = Object.freeze({
    directory: input.destination,
    digest: final.digest!,
    excludedRoots: Object.freeze([...final.excludedRoots]),
    dependencyClosureDigest: decision.dependencyVariant.closureDigest,
  });
  admittedProjects.add(project);
  return { decision, project };
}
