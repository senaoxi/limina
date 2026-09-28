import type { ImportRecord } from '#core/import-graph/context';
import {
  isNamedWorkspacePackage,
  type NamedWorkspacePackage,
  type WorkspacePackage,
} from '#core/workspace/actions';
import { toRelativePath } from '#utils/path';
import path from 'pathe';
import type { DependencyGraphCollectionContext } from './collection-types';

function addNamelessGraphPackageProblem(options: {
  context: DependencyGraphCollectionContext;
  importRecord: ImportRecord;
  packageRole: 'importer' | 'target';
  resolvedFilePath: string;
  workspacePackage: WorkspacePackage;
}): void {
  options.context.problems.push(
    [
      'Dependency graph package identity requires package.json name:',
      `  package.json: ${toRelativePath(options.context.config.rootDir, path.join(options.workspacePackage.directory, 'package.json'))}`,
      `  role: ${options.packageRole}`,
      `  file: ${toRelativePath(options.context.config.rootDir, options.importRecord.filePath)}`,
      `  imported specifier: ${options.importRecord.specifier}`,
      `  resolved file: ${toRelativePath(options.context.config.rootDir, options.resolvedFilePath)}`,
      '  reason: dependency graph nodes and edges are keyed by package name; nameless workspace packages can be source owners but cannot appear as dependency graph nodes.',
      '  fix: add a non-empty package.json name when this workspace package should appear in the dependency graph.',
    ].join('\n'),
  );
}

function validateNamedPackage(options: {
  context: DependencyGraphCollectionContext;
  importRecord: ImportRecord;
  packageRole: 'importer' | 'target';
  resolvedFilePath: string;
  workspacePackage: WorkspacePackage;
}): options is typeof options & {
  workspacePackage: NamedWorkspacePackage;
} {
  if (isNamedWorkspacePackage(options.workspacePackage)) {
    return true;
  }

  addNamelessGraphPackageProblem(options);
  return false;
}

export interface NamedEdgePackages {
  importerPackage: NamedWorkspacePackage;
  targetPackage: NamedWorkspacePackage;
}

export function validateNamedPackages(options: {
  context: DependencyGraphCollectionContext;
  importerPackage: WorkspacePackage;
  importRecord: ImportRecord;
  resolvedFilePath: string;
  targetPackage: WorkspacePackage;
}): NamedEdgePackages | null {
  const importerOptions = {
    context: options.context,
    importRecord: options.importRecord,
    packageRole: 'importer' as const,
    resolvedFilePath: options.resolvedFilePath,
    workspacePackage: options.importerPackage,
  };

  if (!validateNamedPackage(importerOptions)) {
    return null;
  }

  const targetOptions = {
    context: options.context,
    importRecord: options.importRecord,
    packageRole: 'target' as const,
    resolvedFilePath: options.resolvedFilePath,
    workspacePackage: options.targetPackage,
  };

  if (!validateNamedPackage(targetOptions)) {
    return null;
  }

  return {
    importerPackage: importerOptions.workspacePackage,
    targetPackage: targetOptions.workspacePackage,
  };
}
