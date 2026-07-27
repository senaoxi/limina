import { toRelativePath } from '#utils/path';
import type { Stats } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'pathe';
import { createVirtualEntryContent } from './config';
import type { KnipConfig, KnipOwnerProject } from './types';

interface VirtualEntryState {
  createdParentDirectories: Set<string>;
  tempDirectories: string[];
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function createVirtualEntryProject(options: {
  ownerProject: KnipOwnerProject;
  state: VirtualEntryState;
}): Promise<KnipOwnerProject> {
  if (options.ownerProject.virtualEntrySourceFiles.length === 0) {
    return options.ownerProject;
  }

  const parentDirectory = path.join(options.ownerProject.directory, '.tsbuild');
  const parentAlreadyExists = await pathExists(parentDirectory);
  await mkdir(parentDirectory, { recursive: true });
  if (!parentAlreadyExists) {
    options.state.createdParentDirectories.add(parentDirectory);
  }

  const tempDirectory = await mkdtemp(
    path.join(parentDirectory, 'limina-knip-'),
  );
  const virtualEntryPath = path.join(tempDirectory, 'entry.ts');
  options.state.tempDirectories.push(tempDirectory);
  await writeFile(
    virtualEntryPath,
    createVirtualEntryContent(
      options.ownerProject.virtualEntrySourceFiles,
      tempDirectory,
    ),
  );
  return {
    ...options.ownerProject,
    entryFiles: [
      ...options.ownerProject.entryFiles,
      toRelativePath(options.ownerProject.directory, virtualEntryPath),
    ].sort(),
  };
}

function isIgnorableDirectoryCleanupError(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === 'ENOTEMPTY' || code === 'ENOENT';
}

async function removeCreatedParentDirectory(directory: string): Promise<void> {
  try {
    await rmdir(directory);
  } catch (error) {
    if (!isIgnorableDirectoryCleanupError(error)) {
      throw error;
    }
  }
}

async function cleanupVirtualEntries(state: VirtualEntryState): Promise<void> {
  await Promise.all(
    state.tempDirectories.map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
  await Promise.all(
    [...state.createdParentDirectories].map(removeCreatedParentDirectory),
  );
}

export async function withTemporaryVirtualEntries<T>(
  ownerProjects: readonly KnipOwnerProject[],
  run: (ownerProjects: KnipOwnerProject[]) => Promise<T>,
): Promise<T> {
  const state: VirtualEntryState = {
    createdParentDirectories: new Set(),
    tempDirectories: [],
  };

  try {
    const projects = await Promise.all(
      ownerProjects.map((ownerProject) =>
        createVirtualEntryProject({ ownerProject, state }),
      ),
    );
    return await run(projects);
  } finally {
    await cleanupVirtualEntries(state);
  }
}

export async function withTemporaryKnipConfig<T>(
  config: KnipConfig,
  run: (configPath: string) => Promise<T>,
): Promise<T> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'limina-knip-'));
  const configPath = path.join(tempDir, 'knip.json');

  try {
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    return await run(configPath);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

async function statIfPresent(filePath: string): Promise<Stats | null> {
  try {
    return await stat(filePath);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function getDirectoryLinkType(): 'dir' | 'junction' {
  return process.platform === 'win32' ? 'junction' : 'dir';
}

async function mirrorExistingEntry(options: {
  shadowPath: string;
  sourcePath: string;
  sourceStat: Stats;
}): Promise<void> {
  if (options.sourceStat.isDirectory()) {
    await symlink(
      options.sourcePath,
      options.shadowPath,
      getDirectoryLinkType(),
    );
    return;
  }

  if (options.sourceStat.isFile()) {
    await copyFile(options.sourcePath, options.shadowPath);
  }
}

async function mirrorKnipAnalysisRootEntry(options: {
  entryName: string;
  rootDir: string;
  shadowRootDir: string;
}): Promise<void> {
  const sourcePath = path.join(options.rootDir, options.entryName);
  const shadowPath = path.join(options.shadowRootDir, options.entryName);
  const sourceStat = await statIfPresent(sourcePath);
  if (sourceStat === null) {
    return;
  }

  await mirrorExistingEntry({ shadowPath, sourcePath, sourceStat });
}

async function createShadowAnalysisRoot(rootDir: string): Promise<string> {
  const shadowRootDir = await mkdtemp(path.join(tmpdir(), 'limina-knip-root-'));
  await writeFile(
    path.join(shadowRootDir, 'package.json'),
    `${JSON.stringify({ private: true }, null, 2)}\n`,
  );
  const entries = await readdir(rootDir, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.name !== 'package.json')
      .map((entry) =>
        mirrorKnipAnalysisRootEntry({
          entryName: entry.name,
          rootDir,
          shadowRootDir,
        }),
      ),
  );
  return shadowRootDir;
}

export async function withKnipAnalysisRoot<T>(
  rootDir: string,
  run: (analysisRootDir: string) => Promise<T>,
): Promise<T> {
  if (await pathExists(path.join(rootDir, 'package.json'))) {
    return run(rootDir);
  }

  const shadowRootDir = await createShadowAnalysisRoot(rootDir);
  try {
    return await run(shadowRootDir);
  } finally {
    await rm(shadowRootDir, { force: true, recursive: true });
  }
}
