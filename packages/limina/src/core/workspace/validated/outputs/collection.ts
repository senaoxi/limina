import type { ResolvedLiminaConfig } from '#config/runner';
import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import { LiminaStructuredError } from '../../../../check-reporting/errors';
import type { LiminaCheckIssue } from '../../../../source-check/snapshot';
import { outsideOutputs } from '../descriptors/stability';
import { createWorkspaceIssue, displayWorkspacePath } from '../shared';
import {
  createReadableTsconfigCandidate,
  type WorkspaceDescriptorCandidate,
  type WorkspaceTsconfigOutputRootRead,
} from '../types';
import { readWorkspaceTsconfigOutputRoot } from './read';
import { validateOutputRoot } from './validation';

export interface WorkspaceOutputDeclarations {
  declaredPackageOutputs: Map<string, string>;
  explicitOutputs: Map<string, string>;
  packageOutputs: Set<string>;
}

interface OutputCollectionState extends WorkspaceOutputDeclarations {
  activatedPackageRoots: readonly string[];
  config: ResolvedLiminaConfig;
  issues: LiminaCheckIssue[];
}

function throwOutputIssues(issues: readonly LiminaCheckIssue[]): void {
  if (issues.length === 0) return;
  throw new LiminaStructuredError('Workspace output validation failed.', [
    ...issues,
  ]);
}

function createAbsolutePackageOutputIssue(options: {
  config: ResolvedLiminaConfig;
  entryIndex: number;
}): LiminaCheckIssue {
  return {
    ...createWorkspaceIssue({
      code: 'LIMINA_WORKSPACE_OUTPUT_ROOT_INVALID',
      config: options.config,
      evidence: [`declaration: package.entries[${options.entryIndex}].outDir`],
      filePath: options.config.configPath,
      fix: 'Use a config.rootDir-relative package output path.',
      reason: 'package.entries[].outDir must be relative to config.rootDir.',
      title: 'Workspace output root is structurally unsafe',
    }),
    detailLines: [`package.entries[${options.entryIndex}].outDir`],
  };
}

async function collectRelativePackageOutput(options: {
  entryIndex: number;
  outDir: string;
  state: OutputCollectionState;
}): Promise<void> {
  const outputRoot = normalizeAbsolutePath(
    path.resolve(options.state.config.rootDir, options.outDir),
  );
  const issue = await validateOutputRoot({
    activatedPackageRoots: options.state.activatedPackageRoots,
    config: options.state.config,
    declaredAt: options.state.config.configPath,
    outputRoot,
  });
  if (issue !== null) {
    options.state.issues.push({
      ...issue,
      detailLines: [`package.entries[${options.entryIndex}].outDir`],
    });
    return;
  }
  options.state.packageOutputs.add(outputRoot);
  options.state.declaredPackageOutputs.set(
    `${options.state.config.configPath}#package.entries[${options.entryIndex}].outDir`,
    outputRoot,
  );
}

async function collectPackageOutput(options: {
  entryIndex: number;
  outDir: string;
  state: OutputCollectionState;
}): Promise<void> {
  if (!path.isAbsolute(options.outDir)) {
    await collectRelativePackageOutput(options);
    return;
  }
  options.state.issues.push(
    createAbsolutePackageOutputIssue({
      config: options.state.config,
      entryIndex: options.entryIndex,
    }),
  );
}

async function collectPackageEntries(
  entries: NonNullable<NonNullable<ResolvedLiminaConfig['package']>['entries']>,
  state: OutputCollectionState,
): Promise<void> {
  for (const [entryIndex, entry] of entries.entries()) {
    await collectPackageOutput({ entryIndex, outDir: entry.outDir, state });
  }
}

async function collectPackageOutputs(
  state: OutputCollectionState,
): Promise<void> {
  const entries = state.config.package?.entries;
  if (entries !== undefined) await collectPackageEntries(entries, state);
  throwOutputIssues(state.issues);
}

function addInvalidTsconfigOutputIssue(options: {
  candidatePath: string;
  config: ResolvedLiminaConfig;
  issues: LiminaCheckIssue[];
  reason: string;
}): void {
  options.issues.push(
    createWorkspaceIssue({
      code: 'LIMINA_WORKSPACE_OUTPUT_ROOT_INVALID',
      config: options.config,
      evidence: [
        `declaration: ${displayWorkspacePath(options.config.rootDir, options.candidatePath)}`,
      ],
      filePath: options.candidatePath,
      fix: 'Use a non-empty source-config-relative output path.',
      reason: options.reason,
      title: 'Workspace output root is structurally unsafe',
    }),
  );
}

async function collectResolvedTsconfigOutput(options: {
  candidatePath: string;
  outputRoot: string;
  state: OutputCollectionState;
}): Promise<void> {
  const issue = await validateOutputRoot({
    activatedPackageRoots: options.state.activatedPackageRoots,
    config: options.state.config,
    declaredAt: options.candidatePath,
    outputRoot: options.outputRoot,
  });
  if (issue !== null) {
    options.state.issues.push(issue);
    return;
  }
  options.state.explicitOutputs.set(options.candidatePath, options.outputRoot);
}

async function handleTsconfigOutput(options: {
  candidatePath: string;
  output: WorkspaceTsconfigOutputRootRead;
  state: OutputCollectionState;
}): Promise<void> {
  if (options.output.kind === 'absent') return;
  if (options.output.kind === 'invalid') {
    addInvalidTsconfigOutputIssue({
      candidatePath: options.candidatePath,
      config: options.state.config,
      issues: options.state.issues,
      reason: options.output.reason,
    });
    return;
  }
  await collectResolvedTsconfigOutput({
    candidatePath: options.candidatePath,
    outputRoot: options.output.outputRoot,
    state: options.state,
  });
}

async function collectTsconfigOutput(options: {
  candidate: ReturnType<typeof createReadableTsconfigCandidate>;
  state: OutputCollectionState;
}): Promise<void> {
  await handleTsconfigOutput({
    candidatePath: options.candidate.path,
    output: readWorkspaceTsconfigOutputRoot(
      options.state.config,
      options.candidate,
    ),
    state: options.state,
  });
}

async function collectTsconfigOutputs(
  universe: readonly WorkspaceDescriptorCandidate[],
  state: OutputCollectionState,
): Promise<void> {
  const candidates = outsideOutputs(universe, state.packageOutputs)
    .filter((descriptor) => descriptor.kind === 'tsconfig')
    .map((descriptor) =>
      createReadableTsconfigCandidate({
        ownerDirectory: descriptor.ownerDirectory,
        path: descriptor.path,
      }),
    );
  for (const candidate of candidates) {
    await collectTsconfigOutput({ candidate, state });
  }
  throwOutputIssues(state.issues);
}

export async function collectOutputDeclarations(options: {
  activatedPackageRoots: readonly string[];
  config: ResolvedLiminaConfig;
  universe: readonly WorkspaceDescriptorCandidate[];
}): Promise<WorkspaceOutputDeclarations> {
  const state: OutputCollectionState = {
    activatedPackageRoots: options.activatedPackageRoots,
    config: options.config,
    declaredPackageOutputs: new Map(),
    explicitOutputs: new Map(),
    issues: [],
    packageOutputs: new Set(),
  };
  await collectPackageOutputs(state);
  await collectTsconfigOutputs(options.universe, state);
  return {
    declaredPackageOutputs: state.declaredPackageOutputs,
    explicitOutputs: state.explicitOutputs,
    packageOutputs: state.packageOutputs,
  };
}
