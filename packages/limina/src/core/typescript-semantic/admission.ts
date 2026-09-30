import { isPathInsideDirectory, normalizeAbsolutePath } from '#utils/path';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type ts from 'typescript';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
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
  return normalizeAbsolutePath(
    existsSync(fileName) ? realpathSync.native(fileName) : fileName,
  );
}

function getPathIdentities(fileName: string): string[] {
  return [...new Set([normalizeAbsolutePath(fileName), getRealPath(fileName)])];
}

function resolveLibraryFileName(options: {
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
    const referenceFiles = getProjectReferenceSemanticFiles({
      references: project.projectReferences ?? [],
      virtualFiles: project.virtualFiles,
      tsModule,
    });
    for (const fileName of referenceFiles) {
      this.add(fileName, 'project-reference');
    }
  }

  #addConfiguredLibs(libraryNames: readonly string[]): void {
    for (const libraryName of libraryNames) {
      this.addLibReference(libraryName);
    }
  }

  #addTransitiveFile(fileName: string, reason: InclusionReason): void {
    if (this.#mode === 'root-facts') return;
    this.add(fileName, reason);
  }

  #allowExternalModuleTarget(
    resolution: ts.ResolvedModuleFull,
    containingFile?: string,
  ): boolean {
    if (
      !this.#isExternalDeclarationTarget(resolution, containingFile) ||
      this.#project.workspaceSourceBoundary.has(resolution.resolvedFileName)
    ) {
      return false;
    }
    this.add(resolution.resolvedFileName, 'external-module-target');
    return true;
  }

  #isExternalDeclarationTarget(
    resolution: ts.ResolvedModuleFull,
    containingFile?: string,
  ): boolean {
    return (
      resolution.isExternalLibraryImport === true ||
      (isDeclarationFile(resolution.resolvedFileName) &&
        this.#isExternalDeclarationImporter(containingFile))
    );
  }

  #isExternalDeclarationImporter(fileName: string | undefined): boolean {
    if (fileName === undefined || !isDeclarationFile(fileName)) return false;
    return this.#getPathIdentities(fileName).some((identity) => {
      const reasons = this.#reasons.get(identity);
      return ['external-module-target', 'type-reference'].some((reason) =>
        reasons?.has(reason as InclusionReason),
      );
    });
  }

  #getPathIdentities(fileName: string): readonly string[] {
    const normalized = normalizeAbsolutePath(fileName);
    const cached = this.#pathIdentitiesByFileName.get(normalized);
    if (cached !== undefined) return cached;
    const resolved = getPathIdentities(normalized);
    this.#pathIdentitiesByFileName.set(normalized, resolved);
    return resolved;
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
      resolveLibraryFileName({
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
    if (
      this.#mode === 'root-facts' ||
      !isPathInsideDirectory(fileName, this.#defaultLibDirectory)
    )
      return false;
    this.addDefaultLib(fileName);
    return true;
  }

  allowModuleTarget(
    resolution: ts.ResolvedModuleFull,
    containingFile?: string,
  ): boolean {
    return (
      this.has(resolution.resolvedFileName) ||
      (this.#mode !== 'root-facts' &&
        this.#allowExternalModuleTarget(resolution, containingFile))
    );
  }

  has(fileName: string): boolean {
    return this.#getPathIdentities(fileName).some((identity) =>
      this.#reasons.has(identity),
    );
  }
}
