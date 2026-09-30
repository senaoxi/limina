import { toRelativePath } from '#utils/path';
import { access, mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'pathe';
import { createVirtualEntryContent } from './config';
import type { KnipConfig, KnipOwnerProject } from './types';

interface VirtualEntryState {
  createdParentDirectories: Set<string>;
  tempDirectories: string[];
}

async function isPathExists(filePath: string): Promise<boolean> {
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
  const isParentAlreadyExists = await isPathExists(parentDirectory);
  await mkdir(parentDirectory, { recursive: true });
  if (!isParentAlreadyExists) {
    options.state.createdParentDirectories.add(parentDirectory);
  }

  const temporaryDirectory = await mkdtemp(
    path.join(parentDirectory, 'limina-knip-'),
  );
  const virtualEntryPath = path.join(temporaryDirectory, 'entry.ts');
  options.state.tempDirectories.push(temporaryDirectory);
  await writeFile(
    virtualEntryPath,
    createVirtualEntryContent(
      options.ownerProject.virtualEntrySourceFiles,
      temporaryDirectory,
    ),
  );
  return {
    ...options.ownerProject,
    entryFiles: [
      ...options.ownerProject.entryFiles,
      toRelativePath(options.ownerProject.directory, virtualEntryPath),
    ].sort((left, right) => Number(left > right) - Number(left < right)),
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
  const temporaryDirectoryValue = await mkdtemp(
    path.join(tmpdir(), 'limina-knip-'),
  );
  const configPath = path.join(temporaryDirectoryValue, 'knip.json');

  try {
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    return await run(configPath);
  } finally {
    await rm(temporaryDirectoryValue, { force: true, recursive: true });
  }
}
