import { normalizeAbsolutePath } from '#utils/path';
import { readFileSync } from 'node:fs';
import type { ManagedOutputDeclarationLookup } from '../import-graph/managed-output-provider';
import type { SvelteDependencyPreparation } from './dependency';
import { prepareSvelteSemanticDependencies } from './dependency';
import {
  resolveSvelteSemanticToolchain,
  type SvelteSemanticToolchain,
} from './toolchain';
import type { SvelteSemanticProject } from './types';

interface PreparedFile {
  preparation: SvelteDependencyPreparation;
  sourceText: string;
}

function projectIdentity(project: SvelteSemanticProject): string {
  return JSON.stringify({
    adapterVersion: project.adapterVersion,
    configPath: project.configPath,
    generation: project.generation,
    packageRootDir: project.packageRootDir,
    resolverConfigPath: project.resolverConfigPath,
  });
}

export class SvelteSemanticContext {
  readonly project: SvelteSemanticProject;
  readonly toolchain: SvelteSemanticToolchain;
  readonly #preparedByFileName = new Map<string, PreparedFile>();
  readonly #preparedByLookup = new WeakMap<
    ManagedOutputDeclarationLookup,
    Map<string, PreparedFile>
  >();
  #disposed = false;

  constructor(options: {
    project: SvelteSemanticProject;
    toolchain: SvelteSemanticToolchain;
  }) {
    this.project = options.project;
    this.toolchain = options.toolchain;
  }

  prepare(
    fileName: string,
    managedOutputLookup?: ManagedOutputDeclarationLookup,
  ): SvelteDependencyPreparation {
    this.assertActive();
    const normalized = normalizeAbsolutePath(fileName);
    const sourceText = readFileSync(normalized, 'utf8');
    const cache = this.#getPreparationCache(managedOutputLookup);
    const cached = cache.get(normalized);
    if (cached?.sourceText === sourceText) return cached.preparation;
    const preparation = prepareSvelteSemanticDependencies({
      filePath: normalized,
      managedOutputLookup,
      project: this.project,
      sourceText,
      toolchain: this.toolchain,
    });
    cache.set(normalized, { preparation, sourceText });
    return preparation;
  }

  #getPreparationCache(
    managedOutputLookup: ManagedOutputDeclarationLookup | undefined,
  ): Map<string, PreparedFile> {
    if (managedOutputLookup === undefined) return this.#preparedByFileName;
    const cached = this.#preparedByLookup.get(managedOutputLookup);
    if (cached !== undefined) return cached;
    const created = new Map<string, PreparedFile>();
    this.#preparedByLookup.set(managedOutputLookup, created);
    return created;
  }

  assertActive(): void {
    if (this.#disposed)
      throw new Error('Svelte semantic context was disposed.');
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#preparedByFileName.clear();
  }
}

export class SvelteSemanticContextManager {
  readonly #toolchainByRoot = new Map<string, SvelteSemanticToolchain>();
  #active: SvelteSemanticContext | undefined;
  #activeIdentity: string | undefined;
  #disposed = false;

  acquire(project: SvelteSemanticProject): SvelteSemanticContext {
    this.assertActive();
    const identity = projectIdentity(project);
    const active = this.getReusableActive(identity);
    if (active !== undefined) return active;
    this.#active?.dispose();
    const packageRootDir = normalizeAbsolutePath(project.packageRootDir);
    const toolchain = this.getToolchain(packageRootDir);
    this.#active = new SvelteSemanticContext({ project, toolchain });
    this.#activeIdentity = identity;
    return this.#active;
  }

  private assertActive(): void {
    if (this.#disposed) {
      throw new Error('Svelte semantic context manager was disposed.');
    }
  }

  private getReusableActive(
    identity: string,
  ): SvelteSemanticContext | undefined {
    if (this.#activeIdentity !== identity) return undefined;
    this.#active?.assertActive();
    return this.#active;
  }

  private getToolchain(packageRootDir: string): SvelteSemanticToolchain {
    const cached = this.#toolchainByRoot.get(packageRootDir);
    if (cached !== undefined) return cached;
    const toolchain = resolveSvelteSemanticToolchain(packageRootDir);
    this.#toolchainByRoot.set(packageRootDir, toolchain);
    return toolchain;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#active?.dispose();
    this.#active = undefined;
    this.#activeIdentity = undefined;
    this.#toolchainByRoot.clear();
  }
}
