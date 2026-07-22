import { createHash } from 'node:crypto';
import { readdir, readFile, realpath } from 'node:fs/promises';
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

async function collectRegularFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(directoryPath: string): Promise<void> {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
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
