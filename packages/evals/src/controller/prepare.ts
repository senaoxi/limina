import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { contentIdentity } from '../core/identity.ts';
import {
  assertRelativePath,
  captureSnapshot,
  sha256,
} from '../core/snapshot.ts';

const exec = promisify(execFile);

async function outsideCheckout(
  repo: string,
  destination: string,
): Promise<string> {
  if (!path.isAbsolute(destination))
    throw new Error('Preparation output must be outside the source checkout');
  const resolved = path.join(
    await realpath(path.dirname(destination)),
    path.basename(destination),
  );
  if (resolved === repo || resolved.startsWith(`${repo}${path.sep}`))
    throw new Error('Preparation output must be outside the source checkout');
  return resolved;
}
export interface BinaryIdentity {
  executable: string;
  sha256: string;
  version: string;
}
export interface BuildToolchain {
  node: BinaryIdentity;
  pnpm: BinaryIdentity;
  storeDirectory: string;
  registryMetadata: { directory: string; manifestSha256: string };
}
interface InputFile {
  path: string;
  mode: number;
  sha256: string | null;
}
export interface FrozenRepo {
  version: 1;
  head: string;
  status: string;
  contentDigest: string;
  files: InputFile[];
}

async function git(repo: string, arguments_: string[]): Promise<string> {
  const result = await exec('/usr/bin/git', ['-C', repo, ...arguments_], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', LANG: 'C' },
  });
  return result.stdout;
}
async function gitState(repo: string) {
  const [head, status, listed] = await Promise.all([
    git(repo, ['rev-parse', 'HEAD']),
    git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']),
  ]);
  return {
    head: head.trim(),
    status,
    paths: [...new Set(listed.split('\0').filter(Boolean))].toSorted((a, b) =>
      Buffer.compare(Buffer.from(a), Buffer.from(b)),
    ),
  };
}
async function readInput(
  root: string,
  relative: string,
): Promise<{ identity: InputFile; content: Buffer | null }> {
  assertRelativePath(relative);
  const absolute = path.join(root, relative);
  let before;
  try {
    before = await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {
      identity: { path: relative, mode: 0, sha256: null },
      content: null,
    };
  }
  if (!before.isFile())
    throw new Error(`Repository input is not a regular file: ${relative}`);
  const handle = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const content = await handle.readFile();
    const after = await handle.stat();
    if (
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.mode !== after.mode
    )
      throw new Error(`Repository changed while freezing: ${relative}`);
    return {
      identity: {
        path: relative,
        mode: after.mode & 0o7777,
        sha256: sha256(content),
      },
      content,
    };
  } finally {
    await handle.close();
  }
}

/**
Freeze the actual tracked/untracked workspace; HEAD is provenance, not input bytes.
*/
export async function freezeRepo(
  sourceRepo: string,
  outputDirectory: string,
): Promise<FrozenRepo> {
  const repo = await realpath(sourceRepo);
  const destination = await outsideCheckout(repo, outputDirectory);
  const before = await gitState(repo);
  await mkdir(destination, { mode: 0o700 });
  const files: InputFile[] = [];
  for (const relative of before.paths) {
    const input = await readInput(repo, relative);
    files.push(input.identity);
    if (!input.content) continue;
    const target = path.join(destination, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, input.content, {
      flag: 'wx',
      mode: input.identity.mode,
    });
    await chmod(target, input.identity.mode);
  }
  // An independent reread detects edits during copying, including untracked changes.
  const after = await gitState(repo);
  if (contentIdentity(before) !== contentIdentity(after))
    throw new Error('Git/workspace state changed during freeze');
  for (const original of files) {
    const current = await readInput(repo, original.path);
    if (contentIdentity(current.identity) !== contentIdentity(original))
      throw new Error(`Workspace input drift: ${original.path}`);
  }
  return {
    version: 1,
    head: before.head,
    status: before.status,
    contentDigest: contentIdentity(files),
    files,
  };
}

export async function verifyBinary(binary: BinaryIdentity): Promise<void> {
  if (
    !path.isAbsolute(binary.executable) ||
    (await realpath(binary.executable)) !== binary.executable ||
    sha256(await readFile(binary.executable)) !== binary.sha256
  )
    throw new Error('Tool binary does not match frozen identity');
}

/**
Replay only explicitly frozen public registry metadata, never a user HOME.
*/
async function restoreRegistryMetadata(
  toolchain: BuildToolchain,
  home: string,
): Promise<void> {
  const source = toolchain.registryMetadata;
  const manifest = await readFile(
    path.join(source.directory, 'metadata-manifest.json'),
  );
  if (sha256(manifest) !== source.manifestSha256)
    throw new Error('Registry metadata manifest identity mismatch');
  const files = JSON.parse(manifest.toString('utf8')) as {
    path: string;
    sha256: string;
  }[];
  const seen = new Set<string>();
  for (const file of files) {
    assertRelativePath(file.path);
    if (
      !/^(?:metadata|metadata-full|metadata-full-filtered)\/https%3A\+registry\.npmjs\.org\/(?:@[^/]+\/)?[^/]+\.jsonl$/.test(
        file.path,
      ) ||
      seen.has(file.path)
    )
      throw new Error('Unexpected public registry metadata path');
    seen.add(file.path);
    const input = await readInput(source.directory, file.path);
    if (!input.content || input.identity.sha256 !== file.sha256)
      throw new Error(`Registry metadata content mismatch: ${file.path}`);
    const destination = path.join(home, 'Library/Caches/pnpm/v12', file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, input.content, { flag: 'wx', mode: 0o600 });
  }
}

async function runBuildStep(
  executable: string,
  arguments_: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  log: string,
): Promise<void> {
  const output = await open(log, 'wx', 0o600);
  const child = spawn(executable, arguments_, {
    cwd,
    env: environment,
    stdio: ['ignore', output.fd, output.fd],
    detached: true,
  });
  let hasTimedOut = false;
  const timeout = setTimeout(() => {
    hasTimedOut = true;
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
  }, 10 * 60_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    if (code !== 0 || hasTimedOut)
      throw new Error(`Preparation step failed; see ${path.basename(log)}`);
  } finally {
    clearTimeout(timeout);
    await output.sync();
    await output.close();
  }
}

export interface PreparedInputs {
  version: 1;
  identity: string;
  repository: FrozenRepo;
  toolchain: BuildToolchain;
  skillDigest: string;
  artifacts: {
    name: 'limina' | 'limina-migrate';
    path: string;
    sha256: string;
    treeDigest: string;
  }[];
}

/**
No model or service calls. Install is frozen/offline and never runs lifecycle scripts.
*/
export async function prepareInputs(
  sourceRepo: string,
  outputDirectory: string,
  toolchain: BuildToolchain,
): Promise<PreparedInputs> {
  const repo = await realpath(sourceRepo);
  const output = await outsideCheckout(repo, outputDirectory);
  await verifyBinary(toolchain.node);
  await verifyBinary(toolchain.pnpm);
  if (
    toolchain.node.version !== '26.13.0' ||
    toolchain.pnpm.version !== '12.10.1'
  )
    throw new Error('Unadmitted build tool version');
  await mkdir(output, { mode: 0o700 });
  const source = path.join(output, 'source');
  const frozen = await freezeRepo(repo, source);
  await writeFile(
    path.join(output, 'repository.json'),
    `${JSON.stringify(frozen)}\n`,
    { mode: 0o600 },
  );
  const build = path.join(output, 'build');
  await cp(source, build, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  const home = path.join(output, 'home');
  const temporary = path.join(output, 'tmp');
  const logs = path.join(output, 'logs');
  const artifactsDirectory = path.join(output, 'artifacts');
  for (const directory of [home, temporary, logs, artifactsDirectory])
    await mkdir(directory, { mode: 0o700 });
  await restoreRegistryMetadata(toolchain, home);
  const environment = {
    HOME: home,
    PATH: `${path.dirname(toolchain.node.executable)}:${path.dirname(toolchain.pnpm.executable)}:/usr/bin:/bin`,
    TMPDIR: temporary,
    LANG: 'en_US.UTF-8',
    CI: 'true',
    HUSKY: '0',
  };
  const steps: { cwd: string; args: string[] }[] = [
    {
      cwd: build,
      args: [
        'install',
        '--offline',
        '--frozen-lockfile',
        '--ignore-scripts',
        '--store-dir',
        toolchain.storeDirectory,
      ],
    },
    {
      cwd: path.join(build, 'packages/gates'),
      args: ['exec', 'tsc', '-p', 'tsconfig.bootstrap.json'],
    },
    {
      cwd: path.join(build, 'packages/build-tools'),
      args: ['exec', 'tsc', '-p', 'tsconfig.bootstrap.json'],
    },
    {
      cwd: path.join(build, 'packages/limina'),
      args: ['exec', 'rolldown', '--config', 'rolldown.config.ts'],
    },
    {
      cwd: path.join(build, 'packages/limina'),
      args: ['exec', 'tsc', '--project', 'tsconfig.check.json'],
    },
    {
      cwd: path.join(build, 'packages/migrate'),
      args: ['exec', 'rolldown', '--config', 'rolldown.config.ts'],
    },
  ];
  for (const [index, step] of steps.entries())
    await runBuildStep(
      toolchain.pnpm.executable,
      ['with', 'current', ...step.args],
      step.cwd,
      environment,
      path.join(logs, `${index}.log`),
    );
  const artifacts: PreparedInputs['artifacts'] = [];
  for (const [directory, name] of [
    ['limina', 'limina'],
    ['migrate', 'limina-migrate'],
  ] as const) {
    const distribution = path.join(build, 'packages', directory, 'dist');
    const packageManifest = JSON.parse(
      await readFile(path.join(distribution, 'package.json'), 'utf8'),
    ) as { scripts?: unknown };
    if (packageManifest.scripts)
      throw new Error(
        'Generated artifact unexpectedly contains lifecycle scripts',
      );
    const archive = path.join(artifactsDirectory, `${name}.tgz`);
    await runBuildStep(
      toolchain.pnpm.executable,
      ['with', 'current', 'pack', '--ignore-workspace', '--out', archive],
      distribution,
      environment,
      path.join(logs, `pack-${name}.log`),
    );
    const snapshot = await captureSnapshot(distribution, 'F0');
    if (snapshot.status !== 'complete')
      throw new Error('Incomplete product artifact');
    artifacts.push({
      name,
      path: path.relative(output, archive),
      sha256: sha256(await readFile(archive)),
      treeDigest: snapshot.digest!,
    });
  }
  const skill = await captureSnapshot(path.join(source, 'skills/limina'), 'F0');
  if (skill.status !== 'complete') throw new Error('Incomplete Skill input');
  const inputs = {
    version: 1 as const,
    repository: frozen,
    toolchain,
    skillDigest: skill.digest!,
    artifacts,
  };
  const prepared = { ...inputs, identity: contentIdentity(inputs) };
  await writeFile(
    path.join(output, 'prepared.json'),
    `${JSON.stringify(prepared)}\n`,
    { mode: 0o600 },
  );
  return prepared;
}
