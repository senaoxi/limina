import { randomUUID } from 'node:crypto';
import { lstat, rm } from 'node:fs/promises';
import path from 'pathe';
import {
  createExplicitMutationAuthority,
  type MutationAuthority,
  type MutationBoundaryTarget,
  preflightMutationBoundary,
} from '../../utils/mutation-boundary';
import { isMissingError } from './file-state';
import type {
  InitFileMutationPlan,
  InitMutationContext,
} from './mutation-types';

interface MutationPlanBuilder {
  allTargets: MutationBoundaryTarget[];
  filePlans: Map<string, InitFileMutationPlan>;
  generation: string;
  rootDir: string;
}

async function createFileAuthority(options: {
  generation: string;
  rootDir: string;
  targetPath: string;
}): Promise<MutationAuthority> {
  return createExplicitMutationAuthority({
    generation: options.generation,
    logicalMutationRoot: options.targetPath,
    scope: 'file',
    trustedBasePath: options.rootDir,
  });
}

function createFileTarget(
  authority: MutationAuthority,
  targetPath: string,
): MutationBoundaryTarget {
  return { authority, kind: 'file', path: targetPath };
}

function createTempPath(rootDir: string, fileName: string): string {
  return path.join(rootDir, `.${fileName}.${process.pid}.${randomUUID()}.tmp`);
}

async function createFilePlan(
  builder: MutationPlanBuilder,
  fileName: string,
): Promise<InitFileMutationPlan> {
  const targetPath = path.join(builder.rootDir, fileName);
  const tempPath = createTempPath(builder.rootDir, fileName);
  const [authority, tempAuthority] = await Promise.all([
    createFileAuthority({
      generation: builder.generation,
      rootDir: builder.rootDir,
      targetPath,
    }),
    createFileAuthority({
      generation: builder.generation,
      rootDir: builder.rootDir,
      targetPath: tempPath,
    }),
  ]);
  const target = createFileTarget(authority, targetPath);
  const tempTarget = createFileTarget(tempAuthority, tempPath);
  const [snapshot, tempSnapshot] = await Promise.all([
    preflightMutationBoundary([target]),
    preflightMutationBoundary([tempTarget]),
  ]);

  builder.allTargets.push(target, tempTarget);
  return {
    authority,
    snapshot,
    targetPath,
    tempAuthority,
    tempPath,
    tempSnapshot,
  };
}

async function createGeneratedRootPlan(options: {
  generation: string;
  rootDir: string;
}): Promise<{
  authority: MutationAuthority;
  path: string;
  target: MutationBoundaryTarget;
}> {
  const generatedRootPath = path.join(options.rootDir, '.limina');
  const authority = await createExplicitMutationAuthority({
    generation: options.generation,
    logicalMutationRoot: generatedRootPath,
    scope: 'directory',
    trustedBasePath: options.rootDir,
  });

  return {
    authority,
    path: generatedRootPath,
    target: {
      authority,
      kind: 'directory',
      path: generatedRootPath,
      recursive: true,
    },
  };
}

export async function prepareInitMutationContext(options: {
  fileNames: readonly string[];
  rootDir: string;
}): Promise<InitMutationContext> {
  const generation = randomUUID();
  const generatedRoot = await createGeneratedRootPlan({
    generation,
    rootDir: options.rootDir,
  });
  const builder: MutationPlanBuilder = {
    allTargets: [generatedRoot.target],
    filePlans: new Map(),
    generation,
    rootDir: options.rootDir,
  };

  for (const fileName of options.fileNames) {
    const plan = await createFilePlan(builder, fileName);
    builder.filePlans.set(plan.targetPath, plan);
  }

  await preflightMutationBoundary(builder.allTargets);
  return {
    filePlans: builder.filePlans,
    generatedRootAuthority: generatedRoot.authority,
    generatedRootPath: generatedRoot.path,
  };
}

function createGeneratedRootTarget(
  context: InitMutationContext,
): MutationBoundaryTarget {
  return {
    authority: context.generatedRootAuthority,
    kind: 'directory',
    path: context.generatedRootPath,
    recursive: true,
  };
}

async function generatedRootExists(rootPath: string): Promise<boolean> {
  try {
    await lstat(rootPath);
    return true;
  } catch (error) {
    if (isMissingError(error)) {
      return false;
    }

    throw error;
  }
}

export async function removeInitGeneratedRoot(
  context: InitMutationContext,
): Promise<boolean> {
  if (!(await generatedRootExists(context.generatedRootPath))) {
    return false;
  }

  await preflightMutationBoundary([createGeneratedRootTarget(context)]);
  await rm(context.generatedRootPath, { force: true, recursive: true });
  return true;
}
