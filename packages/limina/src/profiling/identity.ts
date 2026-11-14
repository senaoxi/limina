import { compareCodeUnits } from '#utils/collections';
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'pathe';

export interface FileTreeIdentity {
  readonly fileCount: number;
  readonly treeHash: string;
}

export interface RuntimeTreeIdentity extends FileTreeIdentity {
  readonly entryKind: 'source' | 'distribution';
  readonly treeScope: string;
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

function assertRegularIdentityEntry(
  entry: Pick<Dirent, 'isFile' | 'isSymbolicLink'>,
  entryPath: string,
): void {
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

async function collectRegularFiles(rootDirectory: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(directoryPath: string): Promise<void> {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => compareCodeUnits(left.name, right.name));

    for (const entry of entries) {
      await collectIdentityEntry({ directoryPath, entry, files, visit });
    }
  }

  await visit(rootDirectory);
  return files;
}

function compareFilePaths(
  rootDirectory: string,
  left: string,
  right: string,
): number {
  return compareCodeUnits(
    toPortableRelativePath(path.relative(rootDirectory, left)),
    toPortableRelativePath(path.relative(rootDirectory, right)),
  );
}

async function readPackageManifestFile(packageRoot: string): Promise<Buffer> {
  const manifestPath = path.join(packageRoot, 'package.json');
  assertRegularIdentityEntry(await lstat(manifestPath), manifestPath);
  return readFile(manifestPath);
}

async function hashFile(
  treeHash: ReturnType<typeof createHash>,
  rootDirectory: string,
  filePath: string,
): Promise<void> {
  const relativePath = toPortableRelativePath(
    path.relative(rootDirectory, filePath),
  );
  const content =
    filePath === path.join(rootDirectory, 'package.json')
      ? await readPackageManifestFile(rootDirectory)
      : await readFile(filePath);
  const fileHash = createHash('sha256').update(content).digest('hex');

  treeHash.update(relativePath);
  treeHash.update('\0');
  treeHash.update(fileHash);
  treeHash.update('\0');
}

async function hashFiles(
  rootDirectory: string,
  files: readonly string[],
): Promise<FileTreeIdentity> {
  const treeHash = createHash('sha256');
  const orderedFiles = [...files].sort((left, right) =>
    compareFilePaths(rootDirectory, left, right),
  );

  for (const filePath of orderedFiles) {
    await hashFile(treeHash, rootDirectory, filePath);
  }

  return {
    fileCount: files.length,
    treeHash: treeHash.digest('hex'),
  };
}

function getLiminaBinPath(manifest: PackageManifest): string | undefined {
  return typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.limina;
}

async function readPackageBinPath(packageRoot: string): Promise<string> {
  const manifest = JSON.parse(
    (await readPackageManifestFile(packageRoot)).toString('utf8'),
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

async function collectSourceRuntimeFiles(
  packageRoot: string,
): Promise<string[]> {
  const sourceRoot = path.join(packageRoot, 'src');
  const binRoot = path.join(packageRoot, 'bin');
  for (const root of [sourceRoot, binRoot]) {
    if ((await realpath(root)) !== root) {
      throw new Error(
        `Source runtime directory must not be a symbolic link: ${root}.`,
      );
    }
  }
  return [
    path.join(packageRoot, 'package.json'),
    ...(await collectRegularFiles(sourceRoot)),
    ...(await collectRegularFiles(binRoot)),
  ];
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

  const isSourceEntry =
    executableRealPath === path.join(packageRealPath, 'src/cli.ts') &&
    executableLogicalPath === path.join(packageLogicalPath, 'src/cli.ts') &&
    expectedExecutableRealPath === path.join(packageRealPath, 'bin/limina.js');
  if (!isSourceEntry) {
    assertExecutableMatchesPackage({
      executableLogicalPath,
      executableRealPath,
      expectedExecutableRealPath,
    });
  }
  assertExecutableInsideRuntime({ executableRealPath, packageRealPath });
  assertExecutableInsideRuntime({
    executableRealPath: expectedExecutableRealPath,
    packageRealPath,
  });

  const files = isSourceEntry
    ? await collectSourceRuntimeFiles(packageRealPath)
    : await collectRegularFiles(packageRealPath);
  return {
    ...(await hashFiles(packageRealPath, files)),
    entryKind: isSourceEntry ? 'source' : 'distribution',
    treeScope: isSourceEntry
      ? 'package.json, src and bin trees; excludes dependencies, workspace configuration and generated distribution'
      : 'complete linked package tree',
    executableLogicalPath,
    executableRealPath,
    packageLogicalPath,
    packageRealPath,
  };
}
