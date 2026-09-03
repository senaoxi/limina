import { normalizeAbsolutePath } from '#utils/path';
import { createHash } from 'node:crypto';
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

function createIdentity(prefix: string, value: unknown): string {
  return `${prefix}:${createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')}`;
}

export function createTypeScriptSemanticContextIdentity(
  project: TypeScriptSemanticProject,
): string {
  return createIdentity('bounded-typescript-semantic', {
    adapterVersion: 'bounded-typescript-semantic-v2-workspace-boundary',
    admissionMode: project.admissionMode ?? 'full-program',
    configPath: normalizeAbsolutePath(project.configPath),
    fileNames: project.fileNames.map(normalizeAbsolutePath),
    options: project.options,
    projectReferences: (project.projectReferences ?? []).map(
      normalizeReference,
    ),
    workspaceSourceBoundary: project.workspaceSourceBoundary.identity,
  });
}

export function createTypeScriptProjectDependencyFactsIdentity(
  project: TypeScriptSemanticProject,
): string {
  // Project-dependency facts contain root syntax and TypeScript's raw semantic
  // resolutions. The workspace boundary only controls which resolved targets
  // the Program may load transitively; it does not change those root facts.
  return createIdentity('typescript-project-dependency-facts', {
    adapterVersion: 'typescript-project-dependency-facts-v1',
    configPath: normalizeAbsolutePath(project.configPath),
    fileNames: project.fileNames.map(normalizeAbsolutePath),
    options: project.options,
    projectReferences: (project.projectReferences ?? []).map(
      normalizeReference,
    ),
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
