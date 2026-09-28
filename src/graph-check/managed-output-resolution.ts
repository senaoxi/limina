import type { ProjectInfo } from '#core/import-graph/context';
import { isDeclarationFile as isDeclarationFileFamily } from '../core/import-graph/declaration-classifier';
import type { ManagedOutputDeclarationProvider } from '../core/import-graph/managed-output-provider';
import type { ExpectedReferenceCollectionContext } from './reference-types';

export interface ManagedResolution {
  attribution: ManagedOutputDeclarationProvider | null;
  resolvedFilePath: string;
  targetProjectPath: string | null;
}

interface ManagedOutputOptions {
  context: ExpectedReferenceCollectionContext;
  graphResolvedFilePath: string;
  project: ProjectInfo;
}

function getManagedAttribution(options: ManagedOutputOptions): {
  attribution: ManagedOutputDeclarationProvider;
  importingCheckerName: string;
} | null {
  const importingCheckerName = options.context.projectCheckerNamesByPath.get(
    options.project.configPath,
  );
  if (!importingCheckerName) {
    return null;
  }

  const attribution = options.context.managedOutputLookup.resolve(
    options.graphResolvedFilePath,
    importingCheckerName,
  );
  return attribution ? { attribution, importingCheckerName } : null;
}

function createDeclarationResolution(
  options: ManagedOutputOptions,
): ManagedResolution {
  const managed = getManagedAttribution(options);
  return {
    attribution: managed?.attribution ?? null,
    resolvedFilePath: options.graphResolvedFilePath,
    targetProjectPath: null,
  };
}

function createSourceResolution(
  graphResolvedFilePath: string,
): ManagedResolution {
  return {
    attribution: null,
    resolvedFilePath: graphResolvedFilePath,
    targetProjectPath: null,
  };
}

export function resolveManagedOutput(
  options: ManagedOutputOptions,
): ManagedResolution | null {
  return isDeclarationFileFamily(options.graphResolvedFilePath)
    ? createDeclarationResolution(options)
    : createSourceResolution(options.graphResolvedFilePath);
}
