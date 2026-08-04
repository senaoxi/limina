import { isSourceKnipEnabled, type ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import type { WorkspacePackage } from '#core/workspace/actions';
import type { CheckCounter } from '../../check-reporting/stats';
import type { WorkspaceDependencyDeclaration } from '../../core/packages/authority';
import type { SourceFinding } from '../findings';
import { collectKnipSourceIssues, type KnipCliRunner } from '../knip';
import type { SourceCheckIssue } from '../report';
import { createKnipAnalysisPlan, type KnipAnalysisPlan } from './analysis-plan';
import { addGeneratedKnipDiagnostics } from './diagnostics';
import type { OwnerSourceModuleSet } from './unused';
import {
  addUnusedDependencyProblems,
  addUnusedModuleProblems,
} from './unused/findings';
import { collectSourceKnipWorkspaceConfigs } from './workspace-config';

interface KnipValidationOptions {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  generatedGraph: GeneratedTsconfigGraphResult;
  findings: SourceFinding[];
  knipRunner?: KnipCliRunner;
  ownerModuleSets: OwnerSourceModuleSet[];
  sourceIssues: SourceCheckIssue[];
  workspaceDependencyDeclarations: WorkspaceDependencyDeclaration[];
  workspacePackages: WorkspacePackage[];
}

interface PreparedKnipAnalysis {
  plan: KnipAnalysisPlan;
}

function hasKnipWork(plan: KnipAnalysisPlan): boolean {
  return plan.needsDependencyAnalysis || plan.includeFiles;
}

function prepareKnipAnalysis(
  options: KnipValidationOptions,
): PreparedKnipAnalysis | null {
  const knipWorkspaceConfigs = collectSourceKnipWorkspaceConfigs({
    config: options.config,
    findings: options.findings,
    workspacePackages: options.workspacePackages,
  });
  addGeneratedKnipDiagnostics({
    checks: options.checks,
    config: options.config,
    diagnostics: options.generatedGraph.generatedKnipDiagnostics,
    findings: options.findings,
  });
  const plan = createKnipAnalysisPlan({
    config: options.config,
    declarations: options.workspaceDependencyDeclarations,
    findings: options.findings,
    generatedGraph: options.generatedGraph,
    knipWorkspaceConfigs,
    ownerModuleSets: options.ownerModuleSets,
    workspacePackages: options.workspacePackages,
  });

  if (options.findings.length > 0) {
    return null;
  }

  return hasKnipWork(plan) ? { plan } : null;
}

async function runPreparedKnipAnalysis(options: {
  base: KnipValidationOptions;
  prepared: PreparedKnipAnalysis;
}): Promise<void> {
  const knipIssues = await collectKnipSourceIssues({
    analysisGroups: options.prepared.plan.analysisGroups,
    config: options.base.config,
    ignoredKeys: options.prepared.plan.ignoredDependencies,
    includeFiles: options.prepared.plan.includeFiles,
    knipRunner: options.base.knipRunner,
    ownerProjects: options.prepared.plan.ownerProjects,
    workspacePackages: options.base.workspacePackages,
  });

  addUnusedDependencyProblems({
    checks: options.base.checks,
    declarations: options.base.workspaceDependencyDeclarations,
    ignoredDependencies: options.prepared.plan.ignoredDependencies,
    issues: options.base.sourceIssues,
    knipIssues,
  });
  if (options.prepared.plan.includeFiles) {
    addUnusedModuleProblems({
      checks: options.base.checks,
      ignoredModuleKeys: options.prepared.plan.ignoredModuleKeys,
      issues: options.base.sourceIssues,
      knipIssues,
      ownerModuleSets: options.base.ownerModuleSets,
    });
  }
}

export async function addKnipBackedSourceProblems(
  options: KnipValidationOptions,
): Promise<void> {
  if (!isSourceKnipEnabled(options.config)) {
    return;
  }

  const prepared = prepareKnipAnalysis(options);
  if (!prepared) {
    return;
  }

  await runPreparedKnipAnalysis({ base: options, prepared });
}
