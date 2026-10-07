import { performance } from 'node:perf_hooks';
import type ts from 'typescript';
import type { InputKind } from '../analysis-cache/contracts';
import { inputStat } from '../analysis-cache/input-state';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import type { TypeScriptSemanticProject } from './contracts';
class CompilerObservations {
  readonly #cache: NativeAnalysisCache;
  readonly #project: TypeScriptSemanticProject;
  constructor(cache: NativeAnalysisCache, project: TypeScriptSemanticProject) {
    this.#cache = cache;
    this.#project = project;
  }
  #add(file: string, kind: InputKind): void {
    this.#cache.observeCompilerInput(
      this.#project,
      this.#cache.inputs.observe(file, kind),
    );
  }
  #structural(file: string, kind: InputKind, value: unknown): void {
    this.#cache.observeCompilerInput(
      this.#project,
      this.#cache.inputs.structural(file, kind, value),
    );
    this.#add(file, 'binding');
  }
  #content(options: {
    file: string;
    text: string;
    checkedAt: number;
    beforeMtime: number;
  }): void {
    const { file, text, checkedAt, beforeMtime } = options;
    const input = this.#cache.inputs.observeText({
      path: file,
      text,
      checkedAt,
      beforeMtime,
    });
    // Scope content remains in the global manifest classifier. Only a direct
    // JSON member consumes full contents; no additional field hash is added.
    if (!file.endsWith('/package.json'))
      this.#cache.observeCompilerInput(this.#project, input);
  }
  #read(
    file: string,
    read: (file: string) => string | undefined,
  ): string | undefined {
    const before = inputStat(file);
    const checkedAt = Date.now();
    const start = performance.now();
    const text = read(file);
    this.#cache.metrics.compilerReads += 1;
    this.#cache.metrics.compilerReadMs += performance.now() - start;
    if (text === undefined) this.#add(file, 'file');
    else this.#content({ file, text, checkedAt, beforeMtime: before!.mtimeMs });
    this.#add(file, 'binding');
    return text;
  }
  #directories(file: string, read: (file: string) => string[]): string[] {
    const value = read(file);
    // Installed automatic-types enumeration is governed by installation trust.
    if (!file.replaceAll('\\', '/').split('/').includes('node_modules'))
      this.#structural(file, 'directories', value);
    this.#add(file, 'binding');
    return value;
  }
  #optionalHost(base: ts.CompilerHost): void {
    const directoryExists = base.directoryExists?.bind(base);
    if (directoryExists !== undefined)
      base.directoryExists = this.#directoryExists(directoryExists);
    this.#optionalDirectories(base);
  }
  #optionalDirectories(base: ts.CompilerHost): void {
    const getDirectories = base.getDirectories?.bind(base);
    if (getDirectories !== undefined)
      base.getDirectories = (file) => this.#directories(file, getDirectories);
  }
  #directoryExists(
    isPresentAt: (file: string) => boolean,
  ): (file: string) => boolean {
    return (file) => {
      const isPresent = isPresentAt(file);
      this.#structural(file, 'directory', isPresent);
      return isPresent;
    };
  }
  attach(base: ts.CompilerHost): void {
    const fileExists = base.fileExists.bind(base);
    base.fileExists = (file) => {
      const isPresent = fileExists(file);
      this.#structural(file, 'file', isPresent);
      return isPresent;
    };
    const readFile = base.readFile.bind(base);
    base.readFile = (file) => this.#read(file, readFile);
    this.#optionalHost(base);
  }
}
export function observeCompilerReads(
  base: ts.CompilerHost,
  cache: NativeAnalysisCache | undefined,
  project: TypeScriptSemanticProject | undefined,
): void {
  if ([cache === undefined, project === undefined].some(Boolean)) return;
  new CompilerObservations(cache!, project!).attach(base);
}
