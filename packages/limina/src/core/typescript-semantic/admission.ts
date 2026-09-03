import { isPathInsideDirectory, normalizeAbsolutePath } from '#utils/path';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type ts from 'typescript';
import type { TypeScriptSemanticProject } from './contracts';
import { getProjectReferenceSemanticFiles } from './project-references';

type InclusionReason =
  | 'explicit-reference-path'
  | 'external-module-target'
  | 'governed-root'
  | 'lib-environment'
  | 'project-reference'
  | 'type-reference';

function getRealPath(fileName: string): string {
  if (!existsSync(fileName)) return normalizeAbsolutePath(fileName);
  return normalizeAbsolutePath(realpathSync.native(fileName));
}

function getPathIdentities(fileName: string): string[] {
  return [...new Set([normalizeAbsolutePath(fileName), getRealPath(fileName)])];
}

function resolveLibFileName(options: {
  defaultLibDirectory: string;
  name: string;
}): string {
  const lower = options.name.toLowerCase();
  const baseName =
    lower.startsWith('lib.') && lower.endsWith('.d.ts')
      ? lower
      : `lib.${lower}.d.ts`;
  return normalizeAbsolutePath(
    path.join(options.defaultLibDirectory, baseName),
  );
}

export class TypeScriptInclusionLedger {
  readonly #defaultLibDirectory: string;
  readonly #mode: NonNullable<TypeScriptSemanticProject['admissionMode']>;
  readonly #project: TypeScriptSemanticProject;
  readonly #pathIdentitiesByFileName = new Map<string, readonly string[]>();
  readonly #reasons = new Map<string, Set<InclusionReason>>();

  constructor(project: TypeScriptSemanticProject, tsModule: typeof ts) {
    this.#project = project;
    this.#mode = project.admissionMode ?? 'full-program';
    this.#defaultLibDirectory = path.dirname(
      tsModule.getDefaultLibFilePath(project.options),
    );
    this.#addProjectRoots(project.fileNames);
    this.#addInitialTransitiveFiles(project, tsModule);
  }

  #addInitialTransitiveFiles(
    project: TypeScriptSemanticProject,
    tsModule: typeof ts,
  ): void {
    if (this.#mode === 'root-facts') return;
    this.#addProjectReferences(project, tsModule);
    this.#addConfiguredLibs(project.options.lib ?? []);
  }

  #addProjectRoots(fileNames: readonly string[]): void {
    for (const fileName of fileNames) {
      this.add(fileName, 'governed-root');
    }
  }

  #addProjectReferences(
    project: TypeScriptSemanticProject,
    tsModule: typeof ts,
  ): void {
    for (const fileName of getProjectReferenceSemanticFiles({
      references: project.projectReferences ?? [],
      tsModule,
    })) {
      this.add(fileName, 'project-reference');
    }
  }

  #addConfiguredLibs(libNames: readonly string[]): void {
    for (const libName of libNames) {
      this.addLibReference(libName);
    }
  }

  add(fileName: string, reason: InclusionReason): void {
    for (const identity of this.#getPathIdentities(fileName)) {
      const reasons = this.#reasons.get(identity) ?? new Set();
      reasons.add(reason);
      this.#reasons.set(identity, reasons);
    }
  }

  addExplicitReference(fileName: string): void {
    this.#addTransitiveFile(fileName, 'explicit-reference-path');
  }

  addDefaultLib(fileName: string): void {
    this.#addTransitiveFile(fileName, 'lib-environment');
  }

  addLibReference(name: string): void {
    this.#addTransitiveFile(
      resolveLibFileName({
        defaultLibDirectory: this.#defaultLibDirectory,
        name,
      }),
      'lib-environment',
    );
  }

  addResolvedLibrary(fileName: string): void {
    this.#addTransitiveFile(fileName, 'lib-environment');
  }

  addTypeReference(fileName: string): void {
    this.#addTransitiveFile(fileName, 'type-reference');
  }

  allowDefaultLib(fileName: string): boolean {
    if (this.#mode === 'root-facts') return false;
    if (!isPathInsideDirectory(fileName, this.#defaultLibDirectory))
      return false;
    this.addDefaultLib(fileName);
    return true;
  }

  allowModuleTarget(resolution: ts.ResolvedModuleFull): boolean {
    if (this.has(resolution.resolvedFileName)) return true;
    if (this.#mode === 'root-facts') return false;
    return this.#allowExternalModuleTarget(resolution);
  }

  #addTransitiveFile(fileName: string, reason: InclusionReason): void {
    if (this.#mode === 'root-facts') return;
    this.add(fileName, reason);
  }

  #allowExternalModuleTarget(resolution: ts.ResolvedModuleFull): boolean {
    if (resolution.isExternalLibraryImport !== true) return false;
    if (
      this.#project.workspaceSourceBoundary.has(resolution.resolvedFileName)
    ) {
      return false;
    }
    this.add(resolution.resolvedFileName, 'external-module-target');
    return true;
  }

  has(fileName: string): boolean {
    return this.#getPathIdentities(fileName).some((identity) =>
      this.#reasons.has(identity),
    );
  }

  #getPathIdentities(fileName: string): readonly string[] {
    const normalized = normalizeAbsolutePath(fileName);
    const cached = this.#pathIdentitiesByFileName.get(normalized);
    if (cached !== undefined) return cached;
    const resolved = getPathIdentities(normalized);
    this.#pathIdentitiesByFileName.set(normalized, resolved);
    return resolved;
  }
}
