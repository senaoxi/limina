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

function createTemporaryPath(rootDirectory: string, fileName: string): string {
  return path.join(
    rootDirectory,
    `.${fileName}.${process.pid}.${randomUUID()}.tmp`,
  );
}

async function createFilePlan(
  builder: MutationPlanBuilder,
  fileName: string,
): Promise<InitFileMutationPlan> {
  const targetPath = path.join(builder.rootDir, fileName);
  const temporaryPath = createTemporaryPath(builder.rootDir, fileName);
  const [authority, temporaryAuthority] = await Promise.all([
    createFileAuthority({
      generation: builder.generation,
      rootDir: builder.rootDir,
      targetPath,
    }),
    createFileAuthority({
      generation: builder.generation,
      rootDir: builder.rootDir,
      targetPath: temporaryPath,
    }),
  ]);
  const target = createFileTarget(authority, targetPath);
  const temporaryTarget = createFileTarget(temporaryAuthority, temporaryPath);
  const [snapshot, temporarySnapshot] = await Promise.all([
    preflightMutationBoundary([target]),
    preflightMutationBoundary([temporaryTarget]),
  ]);

  builder.allTargets.push(target, temporaryTarget);
  return {
    authority,
    snapshot,
    targetPath,
    tempAuthority: temporaryAuthority,
    tempPath: temporaryPath,
    tempSnapshot: temporarySnapshot,
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

async function isGeneratedRootExists(rootPath: string): Promise<boolean> {
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

export async function isRemoveInitGeneratedRoot(
  context: InitMutationContext,
): Promise<boolean> {
  if (!(await isGeneratedRootExists(context.generatedRootPath))) {
    return false;
  }

  await preflightMutationBoundary([createGeneratedRootTarget(context)]);
  await rm(context.generatedRootPath, { force: true, recursive: true });
  return true;
}
