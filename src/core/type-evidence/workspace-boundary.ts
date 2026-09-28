import type { ResolveImportEvidenceOptions } from './resolution';
import type {
  TypeEvidenceCoreOptions,
  WorkspaceBoundedImportEvidenceOptions,
} from './types';

export function addWorkspaceSourceBoundary(options: {
  input: ResolveImportEvidenceOptions;
  provider: TypeEvidenceCoreOptions['workspaceSourceBoundaryProvider'];
}): WorkspaceBoundedImportEvidenceOptions {
  return {
    ...options.input,
    project: {
      ...options.input.project,
      workspaceSourceBoundary: options.provider(options.input.project),
    },
  };
}
