import { normalizeAbsolutePath } from '#utils/path';
import { performance } from 'node:perf_hooks';
import path from 'pathe';
import type ts from 'typescript';
import type { InputDependency } from './contracts';
import type { AnalysisInputs } from './inputs';
import { packageLocation } from './package-inputs';

export class QueryTrace {
  readonly dependencies: Map<string, InputDependency> = new Map<
    string,
    InputDependency
  >();
  complete = true;
  readonly inputs: AnalysisInputs;
  constructor(inputs: AnalysisInputs) {
    this.inputs = inputs;
  }

  #fileExists(base: ts.ModuleResolutionHost, path: string): boolean {
    const isValue = base.fileExists(path);
    this.add(path, 'binding');
    const dependency = this.inputs.structural(path, 'file', isValue);
    this.record(dependency);
    return isValue;
  }

  #directoryExists(base: ts.ModuleResolutionHost, path: string): boolean {
    if (base.directoryExists === undefined) {
      this.complete = false;
      return true;
    }
    const isValue = base.directoryExists(path);
    if (path.split('/').at(-1) === 'node_modules')
      this.add(path, 'directory-identity');
    if (isValue) this.add(path, 'binding');
    const dependency = this.inputs.structural(path, 'directory', isValue);
    this.record(dependency);
    return isValue;
  }

  #directories(base: ts.ModuleResolutionHost, path: string): string[] {
    if (base.getDirectories === undefined) {
      this.complete = false;
      return [];
    }
    const value = base.getDirectories(path);
    const dependency = this.inputs.structural(path, 'directories', value);
    this.record(dependency);
    this.add(path, 'binding');
    return value;
  }

  #realpath(base: ts.ModuleResolutionHost, path: string): string {
    if (base.realpath === undefined) {
      this.complete = false;
      return path;
    }
    const value = base.realpath(path);
    const dependency = this.inputs.structural(
      path,
      'realpath',
      normalizeAbsolutePath(value),
    );
    this.record(dependency);
    return value;
  }

  #readFile(base: ts.ModuleResolutionHost, path: string): string | undefined {
    this.add(path, 'binding');
    this.add(
      path,
      path.endsWith('/package.json') ? 'manifest' : 'affecting-mtime',
    );
    const start = performance.now();
    const text = base.readFile(path);
    this.inputs.metrics.reads += 1;
    this.inputs.metrics.resolverFileReads =
      (this.inputs.metrics.resolverFileReads ?? 0) + 1;
    this.inputs.metrics.readMs += performance.now() - start;
    if (text === undefined) this.add(path, 'file');
    return text;
  }

  #locations(value: unknown, isAffecting: boolean): void {
    if (value === undefined) return;
    this.#observeLocations(value, isAffecting);
  }

  #observeLocations(value: unknown, isAffecting: boolean): void {
    if (!Array.isArray(value)) {
      this.complete = false;
      return;
    }
    for (const path of value) this.#location(path, isAffecting);
  }

  #location(path: unknown, isAffecting: boolean): void {
    if (typeof path !== 'string') {
      this.complete = false;
      return;
    }
    if (isAffecting) {
      this.add(path, 'binding');
      this.add(
        path,
        path.endsWith('/package.json') ? 'manifest' : 'affecting-mtime',
      );
    } else this.add(path, 'file');
  }

  protected record(dependency: InputDependency): void {
    this.dependencies.set(dependency.inputId, dependency);
  }

  add(path: string, kind: Parameters<AnalysisInputs['observe']>[1]): void {
    const dependency = this.inputs.observe(path, kind);
    this.record(dependency);
  }

  host(base: ts.ModuleResolutionHost): ts.ModuleResolutionHost {
    return {
      ...base,
      fileExists: (path) => this.#fileExists(base, path),
      readFile: (path) => this.#readFile(base, path),
      directoryExists: (path) => this.#directoryExists(base, path),
      getDirectories: (path) => this.#directories(base, path),
      realpath: (path) => this.#realpath(base, path),
    };
  }

  raw(result: unknown): void {
    const raw = result as Record<string, unknown>;
    this.complete &&= ['failedLookupLocations', 'affectingLocations'].every(
      (key) => Object.hasOwn(raw, key),
    );
    const target = (raw.resolvedModule ??
      raw.resolvedTypeReferenceDirective) as
      | { resolvedFileName?: string; originalPath?: string }
      | undefined;
    for (const file of [target?.resolvedFileName, target?.originalPath]) {
      if (!file) continue;
      this.add(file, 'binding');
      const location = packageLocation(file);
      if (location !== undefined)
        this.add(path.join(location, 'package.json'), 'manifest');
    }
    this.#locations(raw.failedLookupLocations, false);
    this.#locations(raw.affectingLocations, true);
  }
}
