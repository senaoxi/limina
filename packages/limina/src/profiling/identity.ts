import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'pathe';

export interface FileTreeIdentity {
  readonly fileCount: number;
  readonly treeHash: string;
}

export interface RuntimeTreeIdentity extends FileTreeIdentity {
  readonly executableLogicalPath: string;
  readonly executableRealPath: string;
  readonly packageLogicalPath: string;
  readonly packageRealPath: string;
}

export interface LinkedRuntimeTreeIdentity extends RuntimeTreeIdentity {
  readonly shimLogicalPath: string;
  readonly shimRealPath: string;
}

const BUILD_INPUT_RELATIVE_PATHS = [
  'nx.json',
  'package.json',
  'packages/limina',
  'packages/plugins/license',
  'packages/utils',
  'pnpm-lock.yaml',
  'tsconfig.base.json',
  'tsconfig.json',
] as const;

const BUILD_INPUT_IGNORED_SEGMENTS = new Set([
  '.cache',
  '.eslintcache',
  '.nx',
  '.tsbuild',
  'coverage',
  'dist',
  'node_modules',
]);

function toPortableRelativePath(value: string): string {
  return value.split(path.sep).join('/');
}

function isPathInsideOrEqual(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

async function collectRegularFiles(
  rootDir: string,
  options: { ignoredSegments?: ReadonlySet<string> } = {},
): Promise<string[]> {
  const files: string[] = [];

  async function visit(directoryPath: string): Promise<void> {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (options.ignoredSegments?.has(entry.name)) continue;
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Identity tree contains a symbolic link: ${entryPath}.`,
        );
      }
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          `Identity tree contains a non-regular file: ${entryPath}.`,
        );
      }
      files.push(entryPath);
    }
  }

  await visit(rootDir);
  return files;
}

async function hashFiles(
  rootDir: string,
  files: readonly string[],
): Promise<FileTreeIdentity> {
  const treeHash = createHash('sha256');

  for (const filePath of [...files].sort((left, right) =>
    toPortableRelativePath(path.relative(rootDir, left)).localeCompare(
      toPortableRelativePath(path.relative(rootDir, right)),
    ),
  )) {
    const relativePath = toPortableRelativePath(
      path.relative(rootDir, filePath),
    );
    const fileHash = createHash('sha256')
      .update(await readFile(filePath))
      .digest('hex');
    treeHash.update(relativePath);
    treeHash.update('\0');
    treeHash.update(fileHash);
    treeHash.update('\0');
  }

  return {
    fileCount: files.length,
    treeHash: treeHash.digest('hex'),
  };
}

async function readPackageBinPath(packageRoot: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
  ) as { bin?: string | Record<string, string> };
  const binPath =
    typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.limina;
  if (!binPath) {
    throw new Error(
      `Limina package does not declare a bin entry: ${packageRoot}.`,
    );
  }
  return binPath;
}

export async function collectRuntimeTreeIdentity(options: {
  executableLogicalPath: string;
  packageLogicalPath: string;
}): Promise<RuntimeTreeIdentity> {
  const packageLogicalPath = path.resolve(options.packageLogicalPath);
  const executableLogicalPath = path.resolve(options.executableLogicalPath);
  const packageRealPath = await realpath(packageLogicalPath);
  const executableRealPath = await realpath(executableLogicalPath);
  const expectedExecutableRealPath = await realpath(
    path.resolve(
      packageLogicalPath,
      await readPackageBinPath(packageLogicalPath),
    ),
  );

  if (executableRealPath !== expectedExecutableRealPath) {
    throw new Error(
      `Limina executable does not match package.json#bin: ${executableLogicalPath}.`,
    );
  }
  if (!isPathInsideOrEqual(packageRealPath, executableRealPath)) {
    throw new Error(
      `Limina executable is outside the linked runtime tree: ${executableRealPath}.`,
    );
  }

  const files = await collectRegularFiles(packageRealPath);
  return {
    ...(await hashFiles(packageRealPath, files)),
    executableLogicalPath,
    executableRealPath,
    packageLogicalPath,
    packageRealPath,
  };
}

export async function collectLinkedRuntimeTreeIdentity(
  consumerRootDir: string,
): Promise<LinkedRuntimeTreeIdentity> {
  const rootDir = path.resolve(consumerRootDir);
  const packageLogicalPath = path.join(rootDir, 'node_modules', 'limina');
  const shimLogicalPath = path.join(rootDir, 'node_modules', '.bin', 'limina');
  const executableLogicalPath = path.resolve(
    packageLogicalPath,
    await readPackageBinPath(packageLogicalPath),
  );
  const shimStats = await lstat(shimLogicalPath);
  if (!shimStats.isFile() && !shimStats.isSymbolicLink()) {
    throw new Error(
      `Limina executable shim is not a file: ${shimLogicalPath}.`,
    );
  }

  return {
    ...(await collectRuntimeTreeIdentity({
      executableLogicalPath,
      packageLogicalPath,
    })),
    shimLogicalPath,
    shimRealPath: await realpath(shimLogicalPath),
  };
}

export async function collectBuildInputIdentity(
  workspaceRootDir: string,
): Promise<FileTreeIdentity> {
  const rootDir = path.resolve(workspaceRootDir);
  const files: string[] = [];

  for (const relativePath of BUILD_INPUT_RELATIVE_PATHS) {
    const targetPath = path.join(rootDir, relativePath);
    let stats;
    try {
      stats = await lstat(targetPath);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        continue;
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`Build input contains a symbolic link: ${targetPath}.`);
    }
    if (stats.isDirectory()) {
      files.push(
        ...(await collectRegularFiles(targetPath, {
          ignoredSegments: BUILD_INPUT_IGNORED_SEGMENTS,
        })),
      );
      continue;
    }
    if (!stats.isFile()) {
      throw new Error(`Build input is not a regular file: ${targetPath}.`);
    }
    files.push(targetPath);
  }

  return hashFiles(rootDir, files);
}
