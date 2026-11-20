import { isDeclarationFile } from '../import-graph/declaration-classifier';
import { compilerFileKey } from './compiler-coverage';
import type { TypeScriptSemanticProject } from './contracts';

/**
Stop at another scope's implementation; its owner governs its own imports.
*/
export function isDependencyContributionInput(
  project: TypeScriptSemanticProject,
  file: string,
  fileKey: (file: string) => string = compilerFileKey,
): boolean {
  const key = fileKey(file);
  return (
    project.fileNames.some((root) => fileKey(root) === key) ||
    isDeclarationFile(file) ||
    !project.workspaceSourceBoundary.has(file)
  );
}
