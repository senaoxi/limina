import path from 'node:path';
import type { ContextRecord, ProjectRecord } from './observability-types';

export interface ProviderRecord {
  id: string;
  view: string;
  analysisGeneration: number;
  providerGeneration: number;
  reason: string;
}

export class ProfileInventory {
  readonly #aliases = new Map<string, string>();
  readonly #identities = new WeakMap<object, Map<string, string>>();
  #sequence = 0;
  #complete = false;

  root?: string;
  readonly projects: Map<string, ProjectRecord> = new Map();
  readonly contexts: Map<string, ContextRecord> = new Map();
  readonly providers: Map<string, ProviderRecord> = new Map();

  id(prefix: string): string {
    return `${prefix}-${++this.#sequence}`;
  }

  identity(object: object, prefix: string): string {
    let keys = this.#identities.get(object);
    if (!keys) {
      keys = new Map();
      this.#identities.set(object, keys);
    }
    let key = keys.get(prefix);
    if (!key) {
      key = this.id(prefix);
      keys.set(prefix, key);
    }
    return key;
  }

  setRoot(root: string): void {
    this.root = path.resolve(root);
  }

  path(file: string): string {
    if (this.root && path.isAbsolute(file)) {
      const relative = path.relative(this.root, file);
      if (relative === '') return '.';
      if (
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      ) {
        const logicalPath = relative.split(path.sep).join('/');
        if (/^(?![^/]*:)[^\\\p{Cc}]+$/u.test(logicalPath)) return logicalPath;
      }
    }
    let alias = this.#aliases.get(file);
    if (!alias) {
      alias = this.id('external');
      this.#aliases.set(file, alias);
    }
    return alias;
  }

  project(
    configPath: string,
    details: Partial<Omit<ProjectRecord, 'id' | 'path'>> = {},
  ): string {
    const projectPath = this.path(configPath);
    const previous = this.projects.get(projectPath);
    const row = {
      ...previous,
      ...details,
      path: projectPath,
      id: previous?.id ?? this.id('project'),
    };
    this.projects.set(projectPath, row);
    return row.id;
  }

  context(
    instance: object,
    project: string,
    providerRun: string,
    checker: string,
    provider: string,
    role: string,
  ): string {
    const key = JSON.stringify([project, providerRun, checker, provider, role]);
    let keys = this.#identities.get(instance);
    if (!keys) {
      keys = new Map();
      this.#identities.set(instance, keys);
    }
    const existing = keys.get(key);
    if (existing) return existing;
    const id = this.id('context');
    this.contexts.set(id, {
      id,
      project,
      providerRun,
      checker,
      provider,
      role,
    });
    keys.set(key, id);
    return id;
  }

  provider(
    instance: object,
    analysisGeneration: number,
    providerGeneration: number,
    reason: string,
    view?: object,
  ): string {
    const id = this.identity(instance, 'provider');
    const previous = this.providers.get(id);
    if (previous === undefined || (view !== undefined && previous.view === id))
      this.providers.set(id, {
        id,
        view: view === undefined ? id : this.identity(view, 'view'),
        analysisGeneration,
        providerGeneration,
        reason,
      });
    return id;
  }

  inventoryComplete(): void {
    this.#complete = true;
  }
  get hasCompleteInventory(): boolean {
    return this.#complete;
  }
}
