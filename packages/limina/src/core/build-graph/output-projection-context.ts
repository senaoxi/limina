import ts from 'typescript';
import { createWorkspaceSourceBoundaryFromProjects } from '../typescript-semantic';
import type { TypeScriptSemanticProject } from '../typescript-semantic/contracts';
import { parseTypeScriptProjectConfig } from '../typescript-semantic/project-references';
import { parseVueOutputConfig } from '../vue-semantic/output-identity';
import type { GeneratedGraphPreparationState } from './prepare-state';
import type { SourceProject } from './types';

/**
 * Generated configs supply compiler inputs, never new Source Config Coverage.
 * Observe the complete staged config set before the transaction is published.
 */
export function outputSemanticProject(
  project: SourceProject,
  state: GeneratedGraphPreparationState,
  owners: ReadonlyMap<string, SourceProject>,
): TypeScriptSemanticProject {
  const virtualFiles = new Map([
    ...(project.virtualFiles ?? []),
    ...state.writeContext.files,
  ]);
  const configPath = project.outputConfigPath;
  if (!state.writeContext.files.has(configPath))
    throw new Error(`Output configuration was not staged: ${configPath}`);
  const vue = project.context.vueSemanticIdentity;
  const parsed =
    vue === undefined
      ? parseTypeScriptProjectConfig({ configPath, virtualFiles, tsModule: ts })
      : parseVueOutputConfig(vue, configPath, virtualFiles);
  if (parsed === undefined || parsed.errors.length > 0)
    throw new Error(`Cannot parse staged output configuration: ${configPath}`);
  return {
    configPath,
    sourceConfigPath: project.configPath,
    options: parsed.options,
    fileNames: parsed.fileNames,
    projectReferences: parsed.projectReferences,
    virtualFiles,
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
