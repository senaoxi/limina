import type ts from 'typescript';
import { createWorkspaceSourceBoundaryFromProjects } from '../typescript-semantic';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import type { TypeScriptSemanticProject } from '../typescript-semantic/contracts';
import type { GeneratedGraphPreparationState } from './prepare-state';
import type { SourceProject } from './types';

function outputOptions(project: SourceProject): ts.CompilerOptions {
  const receipt = project.typeInputProjections?.findLast(
    (input) => input.generatedConfig === project.outputConfigPath,
  );
  if (receipt === undefined)
    throw new Error(
      `Output options were not observed: ${project.outputConfigPath}`,
    );
  return effectiveCompilerOptions(receipt.generatedOptions);
}

/**
 * Generated configs supply compiler inputs, never new Source Config Coverage.
 * Observe the complete staged config set before the transaction is published.
 */
export function outputSemanticProject(
  project: SourceProject,
  state: GeneratedGraphPreparationState,
  owners: ReadonlyMap<string, SourceProject>,
): TypeScriptSemanticProject {
  return {
    configPath: project.outputConfigPath,
    options: outputOptions(project),
    fileNames: project.fileNames,
    projectReferences: [...project.outputReferences].map((path) => ({ path })),
    virtualFiles: new Map([
      ...(project.virtualFiles ?? []),
      ...state.writeContext.files,
    ]),
    analysisBinding: {
      phase: 'locked',
      checker: `${project.checkerName}:output`,
    },
    admissionMode: 'coverage-bounded',
    workspaceSourceBoundary: createWorkspaceSourceBoundaryFromProjects(
      new Set(owners.values()),
      undefined,
      state.sourceConfigCoverage,
    ),
  };
}
