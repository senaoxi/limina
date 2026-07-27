import type { GeneratedOutputDeclarationCopyContext } from '#core/build-graph/runner';
import { normalizeAbsolutePath } from '#utils/path';
import type { CheckIssueReportOptions } from '../../check-reporting/human';
import type { ValidatedWorkspaceContext } from '../../core/workspace/validated-context';
import type { LiminaFlowReporter } from '../../flow';
import { formatErrorMessage, TypecheckLogger } from '../../logger';
import { copyOutputDeclarationInputs } from '../output/copy';
import {
  createOutputDeclarationCopyPlan,
  mergeOutputDeclarationCopyPlans,
} from '../output/plan';
import {
  formatOutputDeclarationCopyErrors,
  formatOutputDeclarationCopyWarnings,
} from '../output/report';
import { OutputDeclarationCopyError } from '../output/types';
import {
  formatTypecheckProblemSummaryReport,
  shouldLogCheckReport,
} from '../runner-shared';
import type { BuildTargetDescriptor } from './target-resolution';

function getCopyContextKey(
  context: GeneratedOutputDeclarationCopyContext,
): string {
  return [context.sourceConfigPath, context.rootDir, context.outDir].join('\0');
}

function getDescriptorContexts(
  descriptor: BuildTargetDescriptor,
): readonly GeneratedOutputDeclarationCopyContext[] {
  return descriptor.outputDeclarationCopyContexts ?? [];
}

export function collectOutputDeclarationCopyContexts(
  descriptors: readonly BuildTargetDescriptor[],
): GeneratedOutputDeclarationCopyContext[] {
  const contextsByKey = new Map<
    string,
    GeneratedOutputDeclarationCopyContext
  >();
  for (const descriptor of descriptors) {
    for (const context of getDescriptorContexts(descriptor)) {
      contextsByKey.set(getCopyContextKey(context), context);
    }
  }
  return [...contextsByKey.values()].sort((left, right) =>
    left.sourceConfigPath.localeCompare(right.sourceConfigPath),
  );
}

function createMissingAuthorityError(
  context: GeneratedOutputDeclarationCopyContext,
): Error {
  return new Error(
    `Missing validated declaration output authority for ${context.sourceConfigPath}.`,
  );
}

function requireAuthorityCapability(options: {
  context: GeneratedOutputDeclarationCopyContext;
  workspaceContext: ValidatedWorkspaceContext;
}) {
  const capability = options.workspaceContext.outputMutationAuthorities?.get(
    normalizeAbsolutePath(options.context.sourceConfigPath),
  );
  if (capability === undefined)
    throw createMissingAuthorityError(options.context);
  return capability;
}

function assertAuthorityOutputRoot(options: {
  capability: ReturnType<typeof requireAuthorityCapability>;
  context: GeneratedOutputDeclarationCopyContext;
}): void {
  const expected = normalizeAbsolutePath(options.context.outDir);
  if (options.capability.outputRoot === expected) return;
  throw createMissingAuthorityError(options.context);
}

function assertAuthorityGeneration(options: {
  capability: ReturnType<typeof requireAuthorityCapability>;
  context: GeneratedOutputDeclarationCopyContext;
  workspaceContext: ValidatedWorkspaceContext;
}): void {
  if (
    options.capability.workspaceGeneration ===
    options.workspaceContext.workspaceMutationGeneration
  ) {
    return;
  }
  throw createMissingAuthorityError(options.context);
}

function getValidatedAuthority(options: {
  context: GeneratedOutputDeclarationCopyContext;
  workspaceContext: ValidatedWorkspaceContext;
}) {
  const capability = requireAuthorityCapability(options);
  assertAuthorityOutputRoot({ capability, context: options.context });
  assertAuthorityGeneration({ ...options, capability });
  return capability.authority;
}

function createCopyPlan(options: {
  contexts: readonly GeneratedOutputDeclarationCopyContext[];
  projectRootDir: string;
  workspaceContext: ValidatedWorkspaceContext;
}) {
  return mergeOutputDeclarationCopyPlans(
    options.contexts.map((context) =>
      createOutputDeclarationCopyPlan({
        authority: getValidatedAuthority({
          context,
          workspaceContext: options.workspaceContext,
        }),
        fileNames: context.fileNames,
        outDir: context.outDir,
        projectRootDir: options.projectRootDir,
        rootDir: context.rootDir,
      }),
    ),
  );
}

function emitCopyWarning(options: {
  flow: LiminaFlowReporter | undefined;
  flowDepth: number;
  warning: string;
}): void {
  options.flow?.warn(options.warning, {
    depth: options.flowDepth + 1,
    persistInteractive: true,
  });
}

function shouldLogCopyWarning(options: {
  flow?: LiminaFlowReporter;
  report?: CheckIssueReportOptions;
}): boolean {
  if (options.flow?.interactive === true) return false;
  return shouldLogCheckReport(options.report);
}

function reportCopyWarning(options: {
  flow?: LiminaFlowReporter;
  flowDepth: number;
  report?: CheckIssueReportOptions;
  warning: string | null;
}): void {
  if (options.warning === null) return;
  emitCopyWarning({
    flow: options.flow,
    flowDepth: options.flowDepth,
    warning: options.warning,
  });
  if (shouldLogCopyWarning(options)) TypecheckLogger.warn(options.warning);
}

function formatCopyError(options: {
  error: unknown;
  projectRootDir: string;
}): string {
  if (!(options.error instanceof OutputDeclarationCopyError)) {
    return formatErrorMessage(options.error);
  }
  return (
    formatOutputDeclarationCopyErrors({
      problems: options.error.problems,
      projectRootDir: options.projectRootDir,
    }) ?? options.error.message
  );
}

function reportCopyError(
  problem: string,
  report: CheckIssueReportOptions | undefined,
): void {
  if (!shouldLogCheckReport(report)) return;
  TypecheckLogger.error(
    formatTypecheckProblemSummaryReport({
      pluralIssueLabel: 'output declaration copy issues',
      problems: [problem],
      singularIssueLabel: 'output declaration copy issue',
      title: 'Build summary',
    }),
  );
}

async function executeCopyPlan(options: {
  plan: ReturnType<typeof createCopyPlan>;
  projectRootDir: string;
  report?: CheckIssueReportOptions;
}): Promise<string | null> {
  try {
    await copyOutputDeclarationInputs(options.plan, {
      projectRootDir: options.projectRootDir,
      requireAuthenticatedAuthorities: true,
    });
    return null;
  } catch (error) {
    const problem = formatCopyError({
      error,
      projectRootDir: options.projectRootDir,
    });
    reportCopyError(problem, options.report);
    return problem;
  }
}

export async function runOutputDeclarationCopyPostBuild(options: {
  buildTargetDescriptors: readonly BuildTargetDescriptor[];
  flow?: LiminaFlowReporter;
  flowDepth: number;
  projectRootDir: string;
  report?: CheckIssueReportOptions;
  workspaceContext: ValidatedWorkspaceContext;
}): Promise<string | null> {
  const contexts = collectOutputDeclarationCopyContexts(
    options.buildTargetDescriptors,
  );
  if (contexts.length === 0) return null;
  const plan = createCopyPlan({
    contexts,
    projectRootDir: options.projectRootDir,
    workspaceContext: options.workspaceContext,
  });
  reportCopyWarning({
    flow: options.flow,
    flowDepth: options.flowDepth,
    report: options.report,
    warning: formatOutputDeclarationCopyWarnings({
      problems: plan.problems,
      projectRootDir: options.projectRootDir,
    }),
  });
  return executeCopyPlan({
    plan,
    projectRootDir: options.projectRootDir,
    report: options.report,
  });
}
