import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import {
  artifactName,
  files,
  fixedNode,
  jobName,
  nativeJob,
  tuples,
} from './contract.ts';
import { executionOrigin } from './evidence.ts';
import { assertHead, lockHash } from './git.ts';
import type { GitHub } from './github.ts';
import {
  digest,
  hashObject,
  invariant,
  outputs,
  readJson,
  writeJson,
} from './io.ts';
import type { ApiJob, ArtifactManifest, Plan } from './types.ts';

function pnpmVersion(): string {
  // pnpm.cmd needs a shell on Windows; the command has no external arguments or input.
  return execFileSync(
    process.platform === 'win32' ? 'cmd.exe' : 'pnpm',
    process.platform === 'win32'
      ? ['/d', '/s', '/c', 'pnpm --version']
      : ['--version'],
    { encoding: 'utf8', timeout: 30_000 },
  ).trim();
}
function inventory(
  directory: string,
  prefix = '',
): { path: string; hash: string; mode: number }[] {
  const result: { path: string; hash: string; mode: number }[] = [];
  const names = readdirSync(path.join(directory, prefix)).sort((left, right) =>
    left < right ? -1 : Number(left > right),
  );
  for (const name of names) {
    const relative = prefix ? prefix + '/' + name : name;
    const absolute = path.join(directory, relative);
    const stat = lstatSync(absolute);
    invariant(!stat.isSymbolicLink(), 'Artifact symlinks are not admitted');
    if (stat.isDirectory()) result.push(...inventory(directory, relative));
    else {
      invariant(stat.isFile(), 'Unsupported artifact entry');
      result.push({
        path: relative,
        hash: digest(readFileSync(absolute)),
        mode: stat.mode & 0o777,
      });
    }
  }
  return result;
}
function isAllowed(name: string, kind: ArtifactManifest['kind']): boolean {
  const packages =
    kind === 'bootstrap'
      ? ['gates', 'build-tools']
      : ['gates', 'build-tools', 'limina', 'migrate'];
  return (
    name
      .split('/')
      .every(
        (part) =>
          !(!part || part === '.' || part === '..' || part.includes('\\')),
      ) &&
    packages.some((package_) =>
      name.startsWith('packages/' + package_ + '/dist/'),
    )
  );
}
function copy(
  source: string,
  destination: string,
  entries: ArtifactManifest['files'],
): void {
  for (const entry of entries) {
    const target = path.join(destination, entry.path);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(source, entry.path), target);
    if (process.platform !== 'win32') chmodSync(target, entry.mode);
  }
}
export function createArtifact(
  plan: Plan,
  kind: ArtifactManifest['kind'],
  job: string,
  tuple: string,
  attempt: number,
): void {
  assertHead(plan.targetSha);
  const runtime =
    plan.nativeTuples.find((item) => item.key === tuple) ||
    (tuple === 'linux-' + fixedNode
      ? { platform: 'linux', node: fixedNode }
      : undefined);
  invariant(
    runtime &&
      process.platform === runtime.platform &&
      process.versions.node === runtime.node,
    'Producer runtime mismatch',
  );
  const packages =
    kind === 'bootstrap'
      ? ['gates', 'build-tools']
      : ['gates', 'build-tools', 'limina', 'migrate'];
  const entries = packages.flatMap((package_) =>
    inventory('packages/' + package_ + '/dist').map((entry) => ({
      ...entry,
      path: 'packages/' + package_ + '/dist/' + entry.path,
    })),
  );
  invariant(
    entries.length > 0 && entries.every((entry) => isAllowed(entry.path, kind)),
    'Invalid artifact inventory',
  );
  rmSync(files.stage, { recursive: true, force: true });
  copy('.', files.stage, entries);
  const manifest: ArtifactManifest = {
    schema: 1,
    kind,
    repository: plan.repository,
    runId: plan.runId,
    producerAttempt: attempt,
    producerJob: job,
    targetSha: plan.targetSha,
    planHash: plan.planHash,
    contractHash: plan.contractHash,
    tuple,
    os: process.platform,
    arch: process.arch,
    node: process.versions.node,
    pnpm: pnpmVersion(),
    lockHash: lockHash(),
    files: entries,
    digest: '',
  };
  manifest.digest = hashObject({ ...manifest, digest: '' });
  writeJson(path.join(files.stage, 'manifest.json'), manifest);
  outputs({
    artifact_name: artifactName(kind, attempt, tuple) + '-' + manifest.digest,
  });
}
export interface ArtifactSource {
  id: number;
  manifestDigest: string;
  kind: ArtifactManifest['kind'];
  producerAttempt: number;
  producerJob: string;
  tuple: string;
}
export async function selectArtifact(
  api: GitHub,
  plan: Plan,
  kind: ArtifactManifest['kind'],
  tuple: string,
): Promise<void> {
  const run = await api.run(plan.runId);
  const attempts = new Map<number, ApiJob[]>();
  // A new full Plan starts a new provenance window. Older partial reruns can
  // fail closed, but a bounded history must never permanently prevent rerun-all.
  for (
    let attempt = Math.max(plan.originAttempt, run.run_attempt - 29);
    attempt <= run.run_attempt;
    attempt++
  )
    attempts.set(attempt, await api.jobs(run.id, attempt));
  const producer = kind === 'bootstrap' ? 'repository-gates' : nativeJob(tuple);
  const matches = attempts
    .get(run.run_attempt)!
    .filter((job) => job.name === jobName(producer, tuple));
  invariant(
    matches.length === 1 && matches[0]!.conclusion === 'success',
    'Own native producer did not succeed',
  );
  const origin = executionOrigin(matches[0]!, attempts);
  const prefix = artifactName(kind, origin.attempt, tuple) + '-';
  const artifacts = (await api.artifacts(run.id)).filter(
    (artifact) =>
      !artifact.expired &&
      artifact.name.startsWith(prefix) &&
      /^[a-f0-9]{64}$/.test(artifact.name.slice(prefix.length)),
  );
  invariant(artifacts.length === 1, 'Missing or ambiguous native artifact');
  const artifact = artifacts[0]!;
  const source: ArtifactSource = {
    id: artifact.id,
    manifestDigest: artifact.name.slice(prefix.length),
    kind,
    producerAttempt: origin.attempt,
    producerJob: producer,
    tuple,
  };
  writeJson('.reports/ci/artifact-source.json', source);
  outputs({ artifact_id: String(artifact.id) });
}
export function restoreArtifact(
  plan: Plan,
  source: ArtifactSource,
  directory = files.restored,
): ArtifactManifest {
  assertHead(plan.targetSha);
  const manifest = readJson<ArtifactManifest>(
    path.join(directory, 'manifest.json'),
  );
  invariant(
    manifest.schema === 1 &&
      manifest.kind === source.kind &&
      manifest.producerAttempt === source.producerAttempt &&
      manifest.producerJob === source.producerJob &&
      manifest.tuple === source.tuple,
    'Artifact producer mismatch',
  );
  invariant(
    manifest.repository === plan.repository &&
      manifest.runId === plan.runId &&
      manifest.planHash === plan.planHash &&
      manifest.contractHash === plan.contractHash &&
      manifest.targetSha === plan.targetSha,
    'Artifact plan identity mismatch',
  );
  const tuple = tuples(plan.rollingNode).find(
    (item) => item.key === source.tuple,
  );
  invariant(
    tuple && manifest.node === tuple.node && manifest.os === tuple.platform,
    'Artifact planned tuple mismatch',
  );
  invariant(
    manifest.os === process.platform &&
      manifest.arch === process.arch &&
      manifest.node === process.versions.node &&
      manifest.pnpm === pnpmVersion() &&
      manifest.lockHash === lockHash(),
    'Artifact runtime mismatch',
  );
  invariant(
    manifest.digest === source.manifestDigest &&
      manifest.digest === hashObject({ ...manifest, digest: '' }),
    'Manifest digest mismatch',
  );
  invariant(
    manifest.files.length > 0 &&
      new Set(manifest.files.map((entry) => entry.path)).size ===
        manifest.files.length &&
      manifest.files.every(
        (entry) =>
          isAllowed(entry.path, manifest.kind) &&
          Number.isSafeInteger(entry.mode) &&
          entry.mode >= 0 &&
          entry.mode <= 0o777,
      ),
    'Unsafe artifact inventory',
  );
  const actual = inventory(directory).filter(
    (entry) => entry.path !== 'manifest.json',
  );
  invariant(
    hashObject(
      actual
        .map(({ path: name, hash }) => [name, hash])
        .sort((left, right) =>
          String(left) < String(right)
            ? -1
            : Number(String(left) > String(right)),
        ),
    ) ===
      hashObject(
        manifest.files
          .map(({ path: name, hash }) => [name, hash])
          .sort((left, right) =>
            String(left) < String(right)
              ? -1
              : Number(String(left) > String(right)),
          ),
      ),
    'Artifact files or digest mismatch',
  );
  // Download permissions are not authoritative. Restore the recorded producer modes.
  const packages = new Set(
    manifest.files.map((entry) => entry.path.split('/', 2)[1]),
  );
  for (const package_ of packages)
    rmSync(path.join('packages', package_!, 'dist'), {
      recursive: true,
      force: true,
    });
  copy(directory, '.', manifest.files);
  const previous = existsSync('.reports/ci/consumed.json')
    ? readJson<ArtifactManifest[]>('.reports/ci/consumed.json')
    : [];
  writeJson('.reports/ci/consumed.json', [...previous, manifest]);
  return manifest;
}
