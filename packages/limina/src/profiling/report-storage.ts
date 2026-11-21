import { randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import {
  assertArtifactPathOperationSafe,
  ensureArtifactParentDirectory,
  type LiminaArtifactNamespace,
  resolveArtifactNamespacePath,
} from '../domain/artifacts/namespace';

const PROFILE_ID =
  /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;
const PROFILE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

type AssertProfilePath = (file: string) => Promise<void>;

function isInside(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function projectRealPath(directory: string): Promise<string> {
  try {
    return await realpath(directory);
  } catch (error) {
    const parent = path.dirname(directory);
    if (parent === directory || !isMissing(error)) throw error;
    return path.join(await projectRealPath(parent), path.basename(directory));
  }
}

async function publishNewProfile(
  file: string,
  content: string,
  assertSafe: AssertProfilePath,
): Promise<void> {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.profile-${randomUUID()}.tmp`);
  await assertSafe(temporary);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertSafe(temporary);
    await assertSafe(file);
    await link(temporary, file);
  } finally {
    try {
      await assertSafe(temporary);
      await unlink(temporary);
    } catch {
      // A replaced parent must not redirect cleanup into another directory.
    }
  }
}

async function isOldManagedProfile(
  file: string,
  cutoff: number,
): Promise<boolean> {
  const original = await lstat(file);
  if (!original.isFile() || original.mtimeMs >= cutoff) return false;
  const document: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (
    typeof document !== 'object' ||
    document === null ||
    !('schemaVersion' in document) ||
    document.schemaVersion !== 2 ||
    !('invocation' in document) ||
    typeof document.invocation !== 'object' ||
    document.invocation === null ||
    !('id' in document.invocation) ||
    document.invocation.id !== path.basename(file, '.json')
  )
    return false;
  const current = await lstat(file);
  return (
    current.isFile() &&
    current.dev === original.dev &&
    current.ino === original.ino &&
    current.mtimeMs === original.mtimeMs
  );
}

async function pruneDefaultProfiles(
  directory: string,
  assertSafe: AssertProfilePath,
): Promise<void> {
  const cutoff = Date.now() - PROFILE_RETENTION_MS;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith('.json') ||
      !PROFILE_ID.test(path.basename(entry.name, '.json'))
    )
      continue;
    const file = path.join(directory, entry.name);
    try {
      await assertSafe(file);
      if (await isOldManagedProfile(file, cutoff)) {
        await assertSafe(file);
        await unlink(file);
      }
    } catch {
      // Retention ignores unreadable, concurrently removed, or unowned files.
    }
  }
}

async function writeManagedProfile(options: {
  namespace: LiminaArtifactNamespace;
  directory: string;
  name: string;
  content: string;
  prune: boolean;
}): Promise<void> {
  const file = path.join(options.directory, options.name);
  const assertSafe: AssertProfilePath = (candidate) =>
    assertArtifactPathOperationSafe(options.namespace, candidate, {
      targetKind: 'file',
    });
  await ensureArtifactParentDirectory(options.namespace, file);
  await publishNewProfile(file, options.content, assertSafe);
  if (options.prune) {
    try {
      await assertArtifactPathOperationSafe(
        options.namespace,
        options.directory,
        { targetKind: 'directory' },
      );
      await pruneDefaultProfiles(options.directory, assertSafe);
    } catch {
      // Publishing an invocation is independent of old-report cleanup.
    }
  }
}

async function writeExternalProfile(options: {
  namespace: LiminaArtifactNamespace | undefined;
  cwd: string;
  directory: string;
  name: string;
  content: string;
}): Promise<void> {
  const logicalRoot = options.namespace?.configRootDir ?? options.cwd;
  const canonicalRoot =
    options.namespace === undefined
      ? await realpath(logicalRoot)
      : path.dirname(options.namespace.canonicalRootDir);
  const directory = await projectRealPath(options.directory);
  if (
    isInside(logicalRoot, options.directory) ||
    isInside(canonicalRoot, directory)
  ) {
    throw new Error(
      'Profile output must be outside the project or in .limina/profiles.',
    );
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryIdentity = await lstat(directory);
  const assertSafe: AssertProfilePath = async () => {
    const current = await lstat(directory);
    if (
      !current.isDirectory() ||
      current.dev !== directoryIdentity.dev ||
      current.ino !== directoryIdentity.ino ||
      (await realpath(directory)) !== directory ||
      (await realpath(options.directory)) !== directory
    ) {
      throw new Error('Profile output directory changed while writing.');
    }
  };
  await publishNewProfile(
    path.join(directory, options.name),
    options.content,
    assertSafe,
  );
}

export async function writeAnalysisProfile(options: {
  namespace: LiminaArtifactNamespace | undefined;
  cwd: string;
  outputDirectory: string | undefined;
  invocationId: string;
  content: string;
}): Promise<void> {
  if (!PROFILE_ID.test(options.invocationId))
    throw new Error('Invalid profile invocation ID.');
  const name = `${options.invocationId}.json`;
  const { namespace, outputDirectory, content } = options;
  if (namespace !== undefined) {
    const managed = resolveArtifactNamespacePath(namespace, 'profiles');
    if (outputDirectory === undefined || isInside(managed, outputDirectory)) {
      return writeManagedProfile({
        namespace,
        directory: outputDirectory ?? managed,
        name,
        content,
        prune: outputDirectory === undefined,
      });
    }
  }
  if (outputDirectory === undefined)
    throw new Error('No profile output directory is available.');
  return writeExternalProfile({
    namespace,
    cwd: options.cwd,
    directory: outputDirectory,
    name,
    content,
  });
}
