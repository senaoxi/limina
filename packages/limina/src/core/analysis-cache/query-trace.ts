import { normalizeAbsolutePath } from '#utils/path';
import { performance } from 'node:perf_hooks';
import type ts from 'typescript';
import type { InputDependency } from './contracts';
import { inputStat } from './input-state';
import type { AnalysisInputs } from './inputs';

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
    this.dependencies.set(dependency.inputId, dependency);
    return isValue;
  }

  #directoryExists(base: ts.ModuleResolutionHost, path: string): boolean {
    if (base.directoryExists === undefined) {
      this.complete = false;
      return true;
    }
    const isValue = base.directoryExists(path);
    if (isValue) this.add(path, 'binding');
    const dependency = this.inputs.structural(path, 'directory', isValue);
    this.dependencies.set(dependency.inputId, dependency);
    return isValue;
  }

  #directories(base: ts.ModuleResolutionHost, path: string): string[] {
    if (base.getDirectories === undefined) {
      this.complete = false;
      return [];
    }
    const value = base.getDirectories(path);
    const dependency = this.inputs.structural(path, 'directories', value);
    this.dependencies.set(dependency.inputId, dependency);
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
    this.dependencies.set(dependency.inputId, dependency);
    return value;
  }

  #readFile(base: ts.ModuleResolutionHost, path: string): string | undefined {
    this.add(path, 'binding');
    const before = inputStat(path);
    const checkedAt = Date.now();
    const start = performance.now();
    const text = base.readFile(path);
    this.inputs.metrics.reads += 1;
    this.inputs.metrics.readMs += performance.now() - start;
    if (text === undefined) {
      this.add(path, 'file');
      return text;
    }
    const dependency = this.inputs.observeText({
      path,
      text,
      checkedAt,
      beforeMtime: before!.mtimeMs,
    });
    if (path.endsWith('/package.json')) this.#manifest(path);
    else this.dependencies.set(dependency.inputId, dependency);
    return text;
  }

  #manifest(path: string): void {
    this.add(path, 'imports');
    this.add(path, 'exports');
  }

  #locations(value: unknown, isManifest: boolean): void {
    if (value === undefined) return;
    this.#observeLocations(value, isManifest);
  }

  #observeLocations(value: unknown, isManifest: boolean): void {
    if (!Array.isArray(value)) {
      this.complete = false;
      return;
    }
    for (const path of value) this.#location(path, isManifest);
  }

  #location(path: unknown, isManifest: boolean): void {
    if (typeof path !== 'string') {
      this.complete = false;
      return;
    }
    if (isManifest) this.#manifest(path);
    else this.add(path, 'file');
  }

  add(path: string, kind: Parameters<AnalysisInputs['observe']>[1]): void {
    const dependency = this.inputs.observe(path, kind);
    this.dependencies.set(dependency.inputId, dependency);
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
    this.#locations(raw.failedLookupLocations, false);
    this.#locations(raw.affectingLocations, true);
  }
}
