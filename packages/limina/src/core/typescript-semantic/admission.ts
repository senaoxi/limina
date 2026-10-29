import { isPathInsideDirectory, normalizeAbsolutePath } from '#utils/path';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type ts from 'typescript';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import type { TypeScriptSemanticProject } from './contracts';
import { getProjectReferenceSemanticFiles } from './project-references';

type InclusionReason =
  | 'explicit-reference-path'
  | 'governed-root'
  | 'lib-environment'
  | 'project-reference'
  | 'type-reference'
  | 'type-support';

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
  readonly #loadingCeiling: ((file: string) => boolean) | undefined;
  readonly #defaultLibDirectory: string;

  readonly #mode: NonNullable<TypeScriptSemanticProject['admissionMode']>;

  readonly #pathIdentitiesByFileName = new Map<string, readonly string[]>();

  readonly #excluded = new Set<string>();

  readonly #pending = new Set<string>();

  readonly #reasons = new Map<string, Set<InclusionReason>>();
  #revision = 0;

  constructor(project: TypeScriptSemanticProject, tsModule: typeof ts) {
    this.#loadingCeiling = project.loadingCeiling;
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

  #allowSupportTarget(
    resolution: ts.ResolvedModuleFull,
    containingFile?: string,
  ): boolean {
    const target = resolution.resolvedFileName;
    if (isDeclarationFile(target) || this.#isSupportImporter(containingFile)) {
      this.add(target, 'type-support');
      return this.has(target);
    }
    return false;
  }

  #isSupportImporter(fileName: string | undefined): boolean {
    return fileName !== undefined && this.isSupportInput(fileName);
  }

  #addReason(
    fileName: string,
    identity: string,
    reason: InclusionReason,
  ): void {
    const reasons = this.#reasons.get(identity) ?? new Set();
    if (!reasons.has(reason)) {
      this.#pending.add(normalizeAbsolutePath(fileName));
      this.#revision++;
    }
    reasons.add(reason);
    this.#reasons.set(identity, reasons);
  }

  #getPathIdentities(fileName: string): readonly string[] {
    const normalized = normalizeAbsolutePath(fileName);
    const cached = this.#pathIdentitiesByFileName.get(normalized);
    if (cached !== undefined) return cached;
    const resolved = getPathIdentities(normalized);
    this.#pathIdentitiesByFileName.set(normalized, resolved);
    return resolved;
  }

  isSupportInput(fileName: string): boolean {
    return (
      this.has(fileName) &&
      (isDeclarationFile(fileName) ||
        this.#getPathIdentities(fileName).some((identity) =>
          [...(this.#reasons.get(identity) ?? [])].some(
            (reason) => reason !== 'governed-root',
          ),
        ))
    );
  }

  beginProgram(): void {
    this.#excluded.clear();
  }

  exclude(fileName: string): void {
    this.#excluded.add(fileName);
  }

  needsProgramRebuild(): boolean {
    return [...this.#excluded].some((fileName) => this.has(fileName));
  }

  get revision(): number {
    return this.#revision;
  }

  takePendingInputs(): string[] {
    const pending = [...this.#pending];
    this.#pending.clear();
    return pending;
  }

  add(fileName: string, reason: InclusionReason): void {
    if (this.#loadingCeiling?.(normalizeAbsolutePath(fileName)) === false)
      return;
    for (const identity of this.#getPathIdentities(fileName)) {
      this.#addReason(fileName, identity, reason);
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
      (this.#mode !== 'root-facts' &&
        this.#allowSupportTarget(resolution, containingFile)) ||
      this.has(resolution.resolvedFileName)
    );
  }

  has(fileName: string): boolean {
    return (
      this.#loadingCeiling?.(normalizeAbsolutePath(fileName)) !== false &&
      this.#getPathIdentities(fileName).some((identity) =>
        this.#reasons.has(identity),
      )
    );
  }
}
