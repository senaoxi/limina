import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import type { ImportRecord } from '../import-analysis/records';
import type { TypeScriptSemanticProject } from './contracts';
import { createImportRecordIdentity } from './import-record';

function normalizeReference(reference: ts.ProjectReference) {
  return {
    circular: reference.circular === true,
    originalPath: reference.originalPath ?? null,
    path: normalizeAbsolutePath(reference.path),
    prepend: reference.prepend === true,
  };
}

export function createTypeScriptSemanticContextIdentity(
  project: TypeScriptSemanticProject,
): string {
  return JSON.stringify({
    adapterVersion: 'bounded-typescript-semantic-v2-workspace-boundary',
    configPath: normalizeAbsolutePath(project.configPath),
    fileNames: project.fileNames.map(normalizeAbsolutePath),
    options: project.options,
    projectReferences: (project.projectReferences ?? []).map(
      normalizeReference,
    ),
    workspaceSourceBoundary: project.workspaceSourceBoundary.identity,
  });
}

export function createRedirectedReferenceIdentity(
  reference: ts.ResolvedProjectReference | undefined,
): string | null {
  if (reference === undefined) return null;
  return JSON.stringify({
    configPath: getRedirectedConfigPath(reference),
    sourceFile: getRedirectedSourceFileName(reference),
  });
}

function getRedirectedConfigPath(
  reference: ts.ResolvedProjectReference,
): string | null {
  const configPath = reference.commandLine.options.configFilePath;
  return typeof configPath === 'string' ? configPath : null;
}

function getRedirectedSourceFileName(
  reference: ts.ResolvedProjectReference,
): string | null {
  return reference.sourceFile?.fileName ?? null;
}

export function createTypeScriptResolutionIdentity(options: {
  contextIdentity: string;
  importRecord: ImportRecord;
  redirectedReferenceIdentity: string | null;
  resolutionMode: ts.ResolutionMode | undefined;
}): string {
  return JSON.stringify({
    context: options.contextIdentity,
    importRecord: createImportRecordIdentity(options.importRecord),
    redirectedReference: options.redirectedReferenceIdentity,
    resolutionMode: options.resolutionMode ?? null,
  });
}
