import type { ValidatedWorkspaceContext } from '../core/workspace/validated-context';
import type { LiminaPreflightManager } from '../preflight';
import { runOutputDeclarationCopyPostBuild } from './build/output-copy';
import { collectBuildTargetProviderClosure } from './build/provider-closure';
import type { ResolvedBuildTarget } from './build/target-resolution';
import { executeCheckerBuildTargets } from './checker/build-execution';
import {
  createCopyFailure,
  createManagedExecutionFailure,
  createManagedPeerFailure,
  createManagedSuccess,
  logManagedBuildStart,
  type ManagedBuildContext,
  reportManagedFailure,
  reportManagedSuccess,
  toCheckerBuildOptions,
  validateManagedSelection,
} from './managed-build-support';
import type { RunBuildOptions, RunBuildResult } from './runner-types';
import {
  collectCheckerPeerDependencyProblems,
  createCheckerTarget,
  type TypecheckTarget,
} from './targets';

function createBuildTargets(options: {
  context: ManagedBuildContext;
  descriptors: ReturnType<typeof collectBuildTargetProviderClosure>;
}): TypecheckTarget[] {
  return options.descriptors.map(
    ({ buildModule, checker, sourceConfigPath }) => ({
      ...createCheckerTarget({
        checker,
        commandOverride: options.context.options.tscCommand,
        configPath: buildModule.path,
        executionKind: 'build',
        projectRootDir: options.context.projectRootDir,
        sourceConfigPath,
        watch: options.context.options.watch,
      }),
      sourceConfigPath,
    }),
  );
}

async function runPostBuildCopy(options: {
  context: ManagedBuildContext;
  descriptors: ReturnType<typeof collectBuildTargetProviderClosure>;
}): Promise<string | null> {
  if (options.context.options.watch === true) return null;
  return runOutputDeclarationCopyPostBuild({
    buildTargetDescriptors: options.descriptors,
    flow: options.context.options.flow,
    flowDepth: options.context.flowDepth,
    projectRootDir: options.context.projectRootDir,
    report: options.context.options.report,
    workspaceContext: options.context.workspaceContext,
  });
}

async function completeManagedBuild(options: {
  context: ManagedBuildContext;
  descriptors: ReturnType<typeof collectBuildTargetProviderClosure>;
  execution: Awaited<ReturnType<typeof executeCheckerBuildTargets>>;
  rootConfigPaths: string[];
  targetCount: number;
}): Promise<RunBuildResult> {
  reportManagedFailure({
    context: options.context,
    execution: options.execution,
  });
  if (!options.execution.passed) {
    return createManagedExecutionFailure(options);
  }
  const copyProblem = await runPostBuildCopy(options);
  if (copyProblem !== null) {
    return createCopyFailure({ ...options, problem: copyProblem });
  }
  reportManagedSuccess({
    context: options.context,
    targetCount: options.targetCount,
  });
  return createManagedSuccess(options);
}

function createContext(options: {
  preflight: LiminaPreflightManager;
  projectRootDir: string;
  request: RunBuildOptions;
  target: Extract<ResolvedBuildTarget, { kind: 'managed' }>;
  workspaceContext: ValidatedWorkspaceContext;
}): ManagedBuildContext {
  return {
    flowDepth: options.request.flowDepth ?? 0,
    options: options.request,
    preflight: options.preflight,
    projectRootDir: options.projectRootDir,
    target: options.target,
    workspaceContext: options.workspaceContext,
  };
}

function getManagedPeerProblems(options: {
  context: ManagedBuildContext;
  descriptors: ReturnType<typeof collectBuildTargetProviderClosure>;
}): string[] {
  return collectCheckerPeerDependencyProblems({
    checkers: options.descriptors.map(({ checker }) => checker),
    imports: options.context.options.config.config?.imports,
    projectRootDir: options.context.projectRootDir,
    resolvePackage: options.context.options.checkerPackageResolver,
  });
}

export async function runManagedBuild(options: {
  cwd: string;
  preflight: LiminaPreflightManager;
  projectRootDir: string;
  request: RunBuildOptions;
  target: Extract<ResolvedBuildTarget, { kind: 'managed' }>;
  workspaceContext: ValidatedWorkspaceContext;
}): Promise<RunBuildResult> {
  const context = createContext(options);
  const selectionFailure = validateManagedSelection(context);
  if (selectionFailure !== null) return selectionFailure;
  const descriptors = collectBuildTargetProviderClosure({
    allCheckers: options.target.allCheckers,
    generatedGraph: options.target.generatedGraph,
    initialTargets: options.target.checkerTargets,
  });
  const peerFailure = createManagedPeerFailure({
    context,
    problems: getManagedPeerProblems({ context, descriptors }),
  });
  if (peerFailure !== null) return peerFailure;
  const targets = createBuildTargets({ context, descriptors });
  const rootConfigPaths = descriptors.map(
    ({ buildModule }) => buildModule.path,
  );
  logManagedBuildStart({
    context,
    cwd: options.cwd,
    rootConfigPaths,
    targetCount: targets.length,
  });
  const execution = await executeCheckerBuildTargets({
    allCheckers: options.target.allCheckers,
    config: options.request.config,
    flowDepth: context.flowDepth,
    generatedGraph: options.target.generatedGraph,
    label: 'build',
    preflight: options.preflight,
    projectRootDir: options.projectRootDir,
    runnerOptions: toCheckerBuildOptions(options.request),
    targets,
    watch: options.request.watch,
    workspaceContext: options.workspaceContext,
  });
  return completeManagedBuild({
    context,
    descriptors,
    execution,
    rootConfigPaths,
    targetCount: targets.length,
  });
}
