import { isDeclarationFile } from '../import-graph/declaration-classifier';
import type { TypeScriptSemanticProject } from './contracts';

/**
Stop at another scope's implementation; its owner governs its own imports.
*/
export function isDependencyContributionInput(
  project: TypeScriptSemanticProject,
  file: string,
): boolean {
  return (
    project.fileNames.includes(file) ||
    isDeclarationFile(file) ||
    !project.workspaceSourceBoundary.has(file)
  );
}
