import {
  cp,
  lstat,
  mkdir,
  readlink,
  realpath,
  symlink,
} from 'node:fs/promises';
import path from 'node:path';
import { captureRoots } from '../core/capture-policy.ts';
import { contentIdentity } from '../core/identity.ts';
import { materializeSnapshot } from '../core/reconstruction.ts';
import {
  assertRelativePath,
  captureSnapshot,
  type Snapshot,
  verifySnapshot,
} from '../core/snapshot.ts';
import type { TaskSpec } from '../core/task.ts';

const limits = { maxBytes: 512 * 1024 * 1024, maxEntries: 20_000 };
const isWithin = (root: string, file: string) =>
  file === root || file.startsWith(`${root}${path.sep}`);
const dependencyRoots = (task: TaskSpec) =>
  captureRoots(task).filter(
    (root) => root === 'node_modules' || root.endsWith('/node_modules'),
  );

/**
Replayed for verifier S0; neither dependencies nor Agent caches are copied.
*/
export async function prepareTaskState(
  directory: string,
  skill: Snapshot | null = null,
) {
  if (skill) {
    verifySnapshot(skill);
    if (
      skill.status !== 'complete' ||
      skill.excludedRoots.length > 0 ||
      skill.entries.every(
        (entry) => !(entry.path === 'SKILL.md' && entry.kind === 'file'),
      )
    )
      throw new Error('Treatment requires a complete frozen Skill');
  }
  await mkdir(path.join(directory, '.agents'), { mode: 0o755 });
  if (!skill) {
    return;
  }

  await mkdir(path.join(directory, '.agents/skills'), { mode: 0o755 });
  await materializeSnapshot(
    skill,
    path.join(directory, '.agents/skills/limina'),
  );
}

export interface AgentRuntimeReceipt {
  identity: string;
  bundleDigest: string;
  dependencyDigest: string;
  links: { path: string; target: string }[];
  readOnlyRoots: string[];
}
const preparedRuntimes = new WeakMap<AgentRuntimeReceipt, string>();

export class ProtectedRuntimeChanged extends Error {
  readonly relativePath: string;
  constructor(relativePath: string, message: string) {
    super(message);
    this.relativePath = relativePath;
  }
}

function validateLayout(task: TaskSpec) {
  const roots = dependencyRoots(task);
  if (!roots.includes('node_modules') || task.installPlan.setupSteps.length > 0)
    throw new Error(
      'Runtime preparation requires excluded dependencies and no unimplemented setup commands',
    );
  const links = structuredClone(task.installPlan.projectLinks ?? []);
  for (const link of links) {
    assertRelativePath(link.path);
    if (
      link.path === 'node_modules' ||
      roots.every(
        (root) =>
          root === 'node_modules' ||
          !(link.path === root || link.path.startsWith(`${root}/`)),
      )
    )
      throw new Error(
        'Project link must belong to an excluded package dependency directory',
      );
    if (
      !link.target ||
      path.posix.isAbsolute(link.target) ||
      link.target.includes('\\') ||
      link.target.includes('\0') ||
      /^[a-z]:/i.test(link.target)
    )
      throw new Error('Project dependency link must be relative');
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(link.path), link.target),
    );
    assertRelativePath(resolved);
    if (resolved === link.path || resolved.startsWith(`${link.path}/`))
      throw new Error('Cyclic project dependency link');
  }
  if (
    new Set(links.map((link) => link.path)).size !== links.length ||
    links.some((link) =>
      links.some(
        (other) => link !== other && other.path.startsWith(`${link.path}/`),
      ),
    )
  )
    throw new Error('Overlapping project dependency links');
  return { roots, links };
}

async function canonicalDirectory(directory: string) {
  const stat = await lstat(directory);
  if (
    !path.isAbsolute(directory) ||
    (await realpath(directory)) !== directory ||
    !stat.isDirectory()
  )
    throw new Error('Preparation needs a canonical controller directory');
}

async function ensureParents(workspace: string, relative: string) {
  let current = workspace;
  const parts = relative.split('/').slice(0, -1);
  for (const part of parts) {
    current = path.join(current, part);
    try {
      await mkdir(current, { mode: 0o755 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = await lstat(current);
    if (!stat.isDirectory() || (await realpath(current)) !== current)
      throw new Error('Dependency link ancestor is not a real directory');
  }
}

/**
Only controller-admitted bundle bytes enter Agent dependencies. Every condition
uses this same layout; native permission grants make the returned roots read-only.
*/
export async function installAgentRuntime(
  task: TaskSpec,
  bundle: { directory: string; digest: string },
  workspace: string,
): Promise<AgentRuntimeReceipt> {
  const { roots, links } = validateLayout(task);
  if (
    task.dependencyPolicy.variants.every(
      (variant) => variant.closureDigest !== bundle.digest,
    )
  )
    throw new Error('Runtime closure is not authorized by this TaskSpec');
  await canonicalDirectory(workspace);
  await canonicalDirectory(bundle.directory);
  if (
    isWithin(workspace, bundle.directory) ||
    isWithin(bundle.directory, workspace)
  )
    throw new Error('Admitted runtime must be outside the Agent workspace');
  const frozen = await captureSnapshot(bundle.directory, 'F0', limits);
  if (frozen.status !== 'complete' || frozen.digest !== bundle.digest)
    throw new Error('Runtime bundle changed before preparation');
  const dependencies = path.join(bundle.directory, 'node_modules');
  await canonicalDirectory(dependencies);
  const before = await captureSnapshot(dependencies, 'F0', limits);
  if (before.status !== 'complete' || !before.digest)
    throw new Error('Incomplete runtime dependencies');
  for (const entry of before.entries) {
    if (entry.kind !== 'symlink') continue;
    const target = path.resolve(
      dependencies,
      path.dirname(entry.path),
      entry.target,
    );
    if (
      path.isAbsolute(entry.target) ||
      !isWithin(dependencies, target) ||
      !isWithin(dependencies, await realpath(target))
    )
      throw new Error('Runtime dependency link escapes its frozen tree');
  }
  const destination = path.join(workspace, 'node_modules');
  // cp merges existing directories: reject that explicitly, including dangling links.
  try {
    await lstat(destination);
    throw new Error('Agent dependency directory already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await cp(dependencies, destination, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
  });
  for (const link of links) {
    await ensureParents(workspace, link.path);
    const target = path.resolve(
      workspace,
      path.dirname(link.path),
      link.target,
    );
    const targetStat = await lstat(target);
    if (
      !isWithin(workspace, await realpath(target)) ||
      !targetStat.isDirectory()
    )
      throw new Error(
        'Project link target must be an existing project directory',
      );
    await symlink(link.target, path.join(workspace, link.path));
  }
  const body = {
    bundleDigest: bundle.digest,
    dependencyDigest: before.digest,
    links,
    readOnlyRoots: roots,
  };
  const receipt = { ...body, identity: contentIdentity(body) };
  preparedRuntimes.set(receipt, receipt.identity);
  await verifyAgentRuntime(workspace, receipt);
  // Detect source drift during the copy as well as destination corruption.
  const after = await captureSnapshot(bundle.directory, 'F0', limits);
  if (after.digest !== bundle.digest)
    throw new Error('Runtime bundle changed during preparation');
  return receipt;
}

export async function verifyAgentRuntime(
  workspace: string,
  receipt: AgentRuntimeReceipt,
) {
  const { identity, ...body } = receipt;
  if (
    preparedRuntimes.get(receipt) !== identity ||
    contentIdentity(body) !== identity
  )
    throw new Error('Runtime receipt changed');
  await canonicalDirectory(workspace);
  const dependencies = path.join(workspace, 'node_modules');
  await canonicalDirectory(dependencies);
  const actual = await captureSnapshot(dependencies, 'F0', limits);
  if (actual.status !== 'complete')
    throw new Error('Protected Agent dependencies could not be captured');
  if (actual.digest !== receipt.dependencyDigest)
    throw new ProtectedRuntimeChanged(
      'node_modules',
      'Protected Agent dependencies changed',
    );
  for (const link of receipt.links) {
    assertRelativePath(link.path);
    const file = path.join(workspace, link.path);
    const parent = path.dirname(file);
    const stat = await lstat(file);
    if (
      (await realpath(parent)) !== parent ||
      !stat.isSymbolicLink() ||
      (await readlink(file)) !== link.target ||
      !isWithin(workspace, await realpath(file))
    )
      throw new ProtectedRuntimeChanged(
        link.path,
        'Protected project dependency link changed',
      );
  }
}
