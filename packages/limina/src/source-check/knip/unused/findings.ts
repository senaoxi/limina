import type { ResolvedLiminaConfig } from '#config/runner';
import type { CheckCounter } from '../../../check-reporting/stats';
import type { WorkspaceDependencyDeclaration } from '../../../core/packages/authority';
import { createWorkspaceDependencyKey } from '../../../core/packages/dependency-authority';
import { projectToPackageOwnerPath } from '../../../core/workspace/owner-identity';
import type { WorkspaceRegionPathIndex } from '../../../core/workspace/validated-context';
import {
  createSourceUnusedModuleFinding,
  createSourceUnusedWorkspaceDependencyFinding,
} from '../../findings';
import type { KnipSourceIssues } from '../../knip';
import type { SourceCheckIssue } from '../../report';
import { createPackageDependencyIssueKey } from '../dependency-key';
import { createOwnerSourceFileKey, type OwnerSourceModuleSet } from '../unused';
import { formatSourceKnipWorkspaceField } from '../workspace-config';

function addUnusedDependencyIfReported(options: {
  checks: CheckCounter;
  declaration: WorkspaceDependencyDeclaration;
  config: ResolvedLiminaConfig;
  ignoredDependencies: Set<string>;
  issues: SourceCheckIssue[];
  issueCodesByKey: Map<string, string>;
}): void {
  options.checks.add();
  const dependencyKey = createWorkspaceDependencyKey(
    options.declaration.importerIdentity,
    options.declaration.dependencyName,
  );
  if (options.ignoredDependencies.has(dependencyKey)) {
    return;
  }

  const externalCode = options.issueCodesByKey.get(
    createPackageDependencyIssueKey(
      options.declaration.importerIdentity,
      options.declaration.dependencyName,
    ),
  );
  if (!externalCode) {
    return;
  }

  options.issues.push(
    createSourceUnusedWorkspaceDependencyFinding({
      dependencyName: options.declaration.dependencyName,
      externalCode,
      ownerName: options.declaration.importer.name,
      configField: knipOwnerField(options.config, options.declaration.importer),
      packageJsonPath: options.declaration.packageJsonPath,
      sectionName: options.declaration.sectionName,
      specifier: options.declaration.specifier,
    }),
  );
}

export function addUnusedDependencyProblems(options: {
  checks: CheckCounter;
  declarations: WorkspaceDependencyDeclaration[];
  config: ResolvedLiminaConfig;
  ignoredDependencies: Set<string>;
  issues: SourceCheckIssue[];
  knipIssues: KnipSourceIssues;
}): void {
  const issueCodesByKey = new Map(
    options.knipIssues.unusedWorkspaceDependencies.map((issue) => [
      createPackageDependencyIssueKey(
        issue.ownerIdentity,
        issue.dependencyName,
      ),
      issue.externalCode,
    ]),
  );

  for (const declaration of options.declarations) {
    addUnusedDependencyIfReported({
      checks: options.checks,
      declaration,
      config: options.config,
      ignoredDependencies: options.ignoredDependencies,
      issues: options.issues,
      issueCodesByKey,
    });
  }
}

function indexModuleSet(options: {
  checks: CheckCounter;
  moduleSet: OwnerSourceModuleSet;
  moduleSetByFilePath: Map<string, OwnerSourceModuleSet>;
}): void {
  if (!options.moduleSet.checkUnusedFiles) {
    return;
  }

  for (const filePath of options.moduleSet.files) {
    options.checks.add();
    options.moduleSetByFilePath.set(filePath, options.moduleSet);
  }
}

function createModuleSetIndex(options: {
  checks: CheckCounter;
  ownerModuleSets: OwnerSourceModuleSet[];
}): Map<string, OwnerSourceModuleSet> {
  const index = new Map<string, OwnerSourceModuleSet>();

  for (const moduleSet of options.ownerModuleSets) {
    indexModuleSet({
      checks: options.checks,
      moduleSet,
      moduleSetByFilePath: index,
    });
  }

  return index;
}

interface ResolvedModuleSet {
  moduleSet: OwnerSourceModuleSet;
  ownerName: string | undefined;
}

function getResolvedModuleSet(options: {
  filePath: string;
  moduleSetByFilePath: Map<string, OwnerSourceModuleSet>;
}): ResolvedModuleSet | null {
  const moduleSet = options.moduleSetByFilePath.get(options.filePath);
  if (!moduleSet) {
    return null;
  }

  const ownerName = moduleSet.owner.name;
  return { moduleSet, ownerName };
}

function isModuleIssueReported(options: {
  ignoredModuleKeys: Set<string>;
  issueKey: string;
  reportedKeys: Set<string>;
}): boolean {
  return (
    options.ignoredModuleKeys.has(options.issueKey) ||
    options.reportedKeys.has(options.issueKey)
  );
}

function addUnusedModuleIfReported(options: {
  config: ResolvedLiminaConfig;
  externalCode: string;
  filePath: string;
  ignoredModuleKeys: Set<string>;
  issues: SourceCheckIssue[];
  moduleSetByFilePath: Map<string, OwnerSourceModuleSet>;
  reportedKeys: Set<string>;
}): void {
  const resolvedModuleSet = getResolvedModuleSet(options);
  if (!resolvedModuleSet) {
    return;
  }

  const issueKey = createOwnerSourceFileKey(
    resolvedModuleSet.moduleSet.ownerIdentity,
    options.filePath,
  );
  if (isModuleIssueReported({ ...options, issueKey })) {
    return;
  }

  options.reportedKeys.add(issueKey);
  options.issues.push(
    createSourceUnusedModuleFinding({
      externalCode: options.externalCode,
      filePath: options.filePath,
      ownerDirectory: resolvedModuleSet.moduleSet.owner.directory,
      ownerName: resolvedModuleSet.ownerName,
      configField: knipOwnerField(
        options.config,
        resolvedModuleSet.moduleSet.owner,
      ),
      packageJsonPath: resolvedModuleSet.moduleSet.owner.packageJsonPath,
    }),
  );
}

export function addUnusedModuleProblems(options: {
  checks: CheckCounter;
  ignoredModuleKeys: Set<string>;
  issues: SourceCheckIssue[];
  knipIssues: KnipSourceIssues;
  ownerModuleSets: OwnerSourceModuleSet[];
  config: ResolvedLiminaConfig;
  pathIndex: WorkspaceRegionPathIndex;
}): void {
  const moduleSetByFilePath = createModuleSetIndex(options);
  const reportedKeys = new Set<string>();

  for (const issue of options.knipIssues.unusedSourceFiles) {
    const filePath = projectToPackageOwnerPath(
      options.pathIndex,
      issue.filePath,
    );
    if (filePath === null) continue;
    addUnusedModuleIfReported({
      config: options.config,
      externalCode: issue.externalCode,
      filePath,
      ignoredModuleKeys: options.ignoredModuleKeys,
      issues: options.issues,
      moduleSetByFilePath,
      reportedKeys,
    });
  }
}
function knipOwnerField(
  config: ResolvedLiminaConfig,
  owner: { directory: string; name?: string },
): string | undefined {
  if (owner.directory === config.governanceRoot.rootDir)
    return 'source.knip.root';
  return owner.name === undefined
    ? undefined
    : formatSourceKnipWorkspaceField(owner.name);
}
