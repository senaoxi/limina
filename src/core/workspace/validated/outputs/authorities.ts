import type { ResolvedLiminaConfig } from '#config/runner';
import { randomUUID } from 'node:crypto';
import { LiminaStructuredError } from '../../../../check-reporting/errors';
import type { LiminaCheckIssue } from '../../../../source-check/snapshot';
import type { WorkspaceOutputMutationAuthority } from '../types';
import {
  createOutputAuthorityIssue,
  createWorkspaceOutputMutationAuthority,
} from './authority';
import type { WorkspaceOutputDeclarations } from './collection';

export interface WorkspaceOutputAuthorities {
  outputMutationAuthorities: Map<string, WorkspaceOutputMutationAuthority>;
  workspaceMutationGeneration: string;
}

function throwOutputIssues(issues: readonly LiminaCheckIssue[]): void {
  if (issues.length === 0) return;
  throw new LiminaStructuredError('Workspace output validation failed.', [
    ...issues,
  ]);
}

async function addOutputAuthority(options: {
  activatedPackageRoots: readonly string[];
  config: ResolvedLiminaConfig;
  declaringSourceConfig: string;
  issues: LiminaCheckIssue[];
  outputMutationAuthorities: Map<string, WorkspaceOutputMutationAuthority>;
  outputRoot: string;
  workspaceMutationGeneration: string;
}): Promise<void> {
  try {
    options.outputMutationAuthorities.set(
      options.declaringSourceConfig,
      await createWorkspaceOutputMutationAuthority({
        activatedPackageRoots: options.activatedPackageRoots,
        config: options.config,
        declaringSourceConfig: options.declaringSourceConfig,
        outputRoot: options.outputRoot,
        workspaceGeneration: options.workspaceMutationGeneration,
      }),
    );
  } catch (error) {
    options.issues.push(
      createOutputAuthorityIssue({
        config: options.config,
        declaredAt: options.declaringSourceConfig.split('#')[0]!,
        error,
        outputRoot: options.outputRoot,
      }),
    );
  }
}

function collectAuthorityDeclarations(options: {
  declarations: WorkspaceOutputDeclarations;
  stableSourceConfigPaths: ReadonlySet<string>;
}): [string, string][] {
  const stableExplicitOutputs = [
    ...options.declarations.explicitOutputs,
  ].filter(([sourceConfigPath]) =>
    options.stableSourceConfigPaths.has(sourceConfigPath),
  );
  return [
    ...options.declarations.declaredPackageOutputs,
    ...stableExplicitOutputs,
  ];
}

export async function createValidatedOutputAuthorities(options: {
  activatedPackageRoots: readonly string[];
  config: ResolvedLiminaConfig;
  declarations: WorkspaceOutputDeclarations;
  stableSourceConfigPaths: ReadonlySet<string>;
}): Promise<WorkspaceOutputAuthorities> {
  const workspaceMutationGeneration = randomUUID();
  const outputMutationAuthorities = new Map<
    string,
    WorkspaceOutputMutationAuthority
  >();
  const issues: LiminaCheckIssue[] = [];
  const declarations = collectAuthorityDeclarations(options);
  for (const [declaringSourceConfig, outputRoot] of declarations) {
    await addOutputAuthority({
      activatedPackageRoots: options.activatedPackageRoots,
      config: options.config,
      declaringSourceConfig,
      issues,
      outputMutationAuthorities,
      outputRoot,
      workspaceMutationGeneration,
    });
  }
  throwOutputIssues(issues);
  return { outputMutationAuthorities, workspaceMutationGeneration };
}
