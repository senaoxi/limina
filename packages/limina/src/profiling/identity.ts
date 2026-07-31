import { compareCodeUnits } from '#utils/collections';
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
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

interface PackageManifest {
  readonly bin?: string | Readonly<Record<string, string>>;
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

function assertRegularIdentityEntry(entry: Dirent, entryPath: string): void {
  if (entry.isSymbolicLink()) {
    throw new Error(`Identity tree contains a symbolic link: ${entryPath}.`);
  }

  if (!entry.isFile()) {
    throw new Error(`Identity tree contains a non-regular file: ${entryPath}.`);
  }
}

async function collectIdentityEntry(options: {
  directoryPath: string;
  entry: Dirent;
  files: string[];
  visit(directoryPath: string): Promise<void>;
}): Promise<void> {
  const entryPath = path.join(options.directoryPath, options.entry.name);

  if (options.entry.isDirectory()) {
    await options.visit(entryPath);
    return;
  }

  assertRegularIdentityEntry(options.entry, entryPath);
  options.files.push(entryPath);
}

async function collectRegularFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(directoryPath: string): Promise<void> {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => compareCodeUnits(left.name, right.name));

    for (const entry of entries) {
      await collectIdentityEntry({ directoryPath, entry, files, visit });
    }
  }

  await visit(rootDir);
  return files;
}

function compareFilePaths(
  rootDir: string,
  left: string,
  right: string,
): number {
  return compareCodeUnits(
    toPortableRelativePath(path.relative(rootDir, left)),
    toPortableRelativePath(path.relative(rootDir, right)),
  );
}

async function hashFile(
  treeHash: ReturnType<typeof createHash>,
  rootDir: string,
  filePath: string,
): Promise<void> {
  const relativePath = toPortableRelativePath(path.relative(rootDir, filePath));
  const fileHash = createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');

  treeHash.update(relativePath);
  treeHash.update('\0');
  treeHash.update(fileHash);
  treeHash.update('\0');
}

async function hashFiles(
  rootDir: string,
  files: readonly string[],
): Promise<FileTreeIdentity> {
  const treeHash = createHash('sha256');
  const orderedFiles = [...files].sort((left, right) =>
    compareFilePaths(rootDir, left, right),
  );

  for (const filePath of orderedFiles) {
    await hashFile(treeHash, rootDir, filePath);
  }

  return {
    fileCount: files.length,
    treeHash: treeHash.digest('hex'),
  };
}

function getLiminaBinPath(manifest: PackageManifest): string | undefined {
  if (typeof manifest.bin === 'string') {
    return manifest.bin;
  }

  return manifest.bin?.limina;
}

async function readPackageBinPath(packageRoot: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
  ) as PackageManifest;
  const binPath = getLiminaBinPath(manifest);

  if (!binPath) {
    throw new Error(
      `Limina package does not declare a bin entry: ${packageRoot}.`,
    );
  }

  return binPath;
}

function assertExecutableMatchesPackage(options: {
  executableLogicalPath: string;
  executableRealPath: string;
  expectedExecutableRealPath: string;
}): void {
  if (options.executableRealPath !== options.expectedExecutableRealPath) {
    throw new Error(
      `Limina executable does not match package.json#bin: ${options.executableLogicalPath}.`,
    );
  }
}

function assertExecutableInsideRuntime(options: {
  executableRealPath: string;
  packageRealPath: string;
}): void {
  if (
    !isPathInsideOrEqual(options.packageRealPath, options.executableRealPath)
  ) {
    throw new Error(
      `Limina executable is outside the linked runtime tree: ${options.executableRealPath}.`,
    );
  }
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

  assertExecutableMatchesPackage({
    executableLogicalPath,
    executableRealPath,
    expectedExecutableRealPath,
  });
  assertExecutableInsideRuntime({ executableRealPath, packageRealPath });

  const files = await collectRegularFiles(packageRealPath);
  return {
    ...(await hashFiles(packageRealPath, files)),
    executableLogicalPath,
    executableRealPath,
    packageLogicalPath,
    packageRealPath,
  };
}
