import { normalizeAbsolutePath } from '#utils/path';
import type { CheckCounter } from '../../../check-reporting/stats';
import type { WorkspaceDependencyDeclaration } from '../../../core/packages/authority';
import { createWorkspaceDependencyKey } from '../../../core/packages/dependency-authority';
import {
  createSourceUnusedModuleFinding,
  createSourceUnusedWorkspaceDependencyFinding,
} from '../../findings';
import type { KnipSourceIssues } from '../../knip';
import type { SourceCheckIssue } from '../../report';
import { createPackageDependencyIssueKey } from '../dependency-key';
import { createOwnerSourceFileKey, type OwnerSourceModuleSet } from '../unused';

function addUnusedDependencyIfReported(options: {
  checks: CheckCounter;
  declaration: WorkspaceDependencyDeclaration;
  ignoredDependencies: Set<string>;
  issues: SourceCheckIssue[];
  issueCodesByKey: Map<string, string>;
}): void {
  options.checks.add();
  const dependencyKey = createWorkspaceDependencyKey(
    options.declaration.importer.name,
    options.declaration.dependencyName,
  );
  if (options.ignoredDependencies.has(dependencyKey)) {
    return;
  }

  const externalCode = options.issueCodesByKey.get(
    createPackageDependencyIssueKey(
      options.declaration.packageJsonPath,
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
      packageJsonPath: options.declaration.packageJsonPath,
      sectionName: options.declaration.sectionName,
      specifier: options.declaration.specifier,
    }),
  );
}

export function addUnusedDependencyProblems(options: {
  checks: CheckCounter;
  declarations: WorkspaceDependencyDeclaration[];
  ignoredDependencies: Set<string>;
  issues: SourceCheckIssue[];
  knipIssues: KnipSourceIssues;
}): void {
  const issueCodesByKey = new Map(
    options.knipIssues.unusedWorkspaceDependencies.map((issue) => [
      createPackageDependencyIssueKey(
        issue.packageJsonPath,
        issue.dependencyName,
      ),
      issue.externalCode,
    ]),
  );

  for (const declaration of options.declarations) {
    addUnusedDependencyIfReported({
      checks: options.checks,
      declaration,
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

interface NamedModuleSet {
  moduleSet: OwnerSourceModuleSet;
  ownerName: string;
}

function getNamedModuleSet(options: {
  filePath: string;
  moduleSetByFilePath: Map<string, OwnerSourceModuleSet>;
}): NamedModuleSet | null {
  const moduleSet = options.moduleSetByFilePath.get(options.filePath);
  if (!moduleSet) {
    return null;
  }

  const ownerName = moduleSet.owner.name;
  return ownerName ? { moduleSet, ownerName } : null;
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
  externalCode: string;
  filePath: string;
  ignoredModuleKeys: Set<string>;
  issues: SourceCheckIssue[];
  moduleSetByFilePath: Map<string, OwnerSourceModuleSet>;
  reportedKeys: Set<string>;
}): void {
  const namedModuleSet = getNamedModuleSet(options);
  if (!namedModuleSet) {
    return;
  }

  const issueKey = createOwnerSourceFileKey(
    namedModuleSet.ownerName,
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
      ownerDirectory: namedModuleSet.moduleSet.owner.directory,
      ownerName: namedModuleSet.ownerName,
      packageJsonPath: namedModuleSet.moduleSet.owner.packageJsonPath,
    }),
  );
}

export function addUnusedModuleProblems(options: {
  checks: CheckCounter;
  ignoredModuleKeys: Set<string>;
  issues: SourceCheckIssue[];
  knipIssues: KnipSourceIssues;
  ownerModuleSets: OwnerSourceModuleSet[];
}): void {
  const moduleSetByFilePath = createModuleSetIndex(options);
  const reportedKeys = new Set<string>();

  for (const issue of options.knipIssues.unusedSourceFiles) {
    addUnusedModuleIfReported({
      externalCode: issue.externalCode,
      filePath: normalizeAbsolutePath(issue.filePath),
      ignoredModuleKeys: options.ignoredModuleKeys,
      issues: options.issues,
      moduleSetByFilePath,
      reportedKeys,
    });
  }
}
