import type { VueProjectSemanticIdentity } from '#checkers';
import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import type { InputDependency } from './contracts';
import { analysisHash } from './identity';
import { inputStat } from './input-state';
import type { AnalysisInputs } from './inputs';
import { QueryTrace } from './query-trace';
import type { VueModuleReplay } from './vue-module-replay';
import { observeVueTools } from './vue-toolchain-inputs';

export class VueInputTrace extends QueryTrace {
  #resolution: { trace: QueryTrace; members: Set<string> } | undefined;
  readonly #configPaths: Set<string>;
  readonly members: Set<string> = new Set<string>();
  readonly generated: Record<string, string> = {};
  moduleReplay: VueModuleReplay | undefined;

  constructor(inputs: AnalysisInputs, identity: VueProjectSemanticIdentity) {
    super(inputs);
    this.#configPaths = new Set(
      identity.configClosure.map((entry) =>
        normalizeAbsolutePath(entry.filePath),
      ),
    );
    inputs.observeConfig(identity.configClosure);
    for (const entry of identity.configClosure) {
      this.add(entry.filePath, 'config-mtime');
      this.add(entry.filePath, 'binding');
    }
    for (const file of identity.fileNames) {
      this.add(file, 'content');
      this.add(file, 'binding');
    }
    const configurations =
      identity.declarationLoading?.coverage.configurations ?? [];
    for (const config of configurations) {
      this.add(config.configId, 'config-mtime');
      this.add(config.configId, 'binding');
      if (config.state === 'enumerated')
        for (const member of config.members) {
          this.add(member.lexicalPath, 'binding');
        }
    }
    observeVueTools(identity, this);
  }

  #realpath(
    base: typeof ts.sys,
    host: ts.ModuleResolutionHost,
    file: string,
  ): string {
    return inputStat(file) === undefined
      ? this.#missingRealpath(base, file)
      : host.realpath!(file);
  }

  #missingRealpath(base: typeof ts.sys, file: string): string {
    // Volar resolves synthetic .d.vue.ts paths through TypeScript's lexical
    // fallback. Persist physical absence and bindings, not a synthetic path
    // as a successful filesystem realpath observation.
    this.add(file, 'binding');
    this.add(file, 'realpath');
    const resolved = base.realpath?.(file);
    if (!isLexicalRealpath(file, resolved)) this.#markIncomplete();
    return resolved ?? file;
  }

  #markIncomplete(): void {
    this.complete = false;
    if (this.#resolution !== undefined) this.#resolution.trace.complete = false;
  }

  protected override record(dependency: InputDependency): void {
    super.record(dependency);
    this.#resolution?.trace.dependencies.set(dependency.inputId, dependency);
  }

  collectResolution<T>(collect: () => T): {
    result: T;
    trace: QueryTrace;
    members: string[];
  } {
    const trace = new QueryTrace(this.inputs);
    const members = new Set<string>();
    this.#resolution = { trace, members };
    try {
      return { result: collect(), trace, members: [...members] };
    } finally {
      this.#resolution = undefined;
    }
  }

  member(file: string): void {
    this.members.add(file);
    this.#resolution?.members.add(file);
  }

  retainResolution(
    dependencies: readonly InputDependency[],
    members: readonly string[],
  ): void {
    for (const member of members) this.member(member);
    for (const dependency of dependencies) this.record(dependency);
    this.inputs.consume(dependencies);
  }

  script(file: string): void {
    const normalized = normalizeAbsolutePath(file);
    const kind = this.#configPaths.has(normalized)
      ? 'config-mtime'
      : normalized.endsWith('/package.json')
        ? 'manifest'
        : 'content';
    this.add(file, kind);
    this.add(file, 'binding');
  }

  system(base: typeof ts.sys): typeof ts.sys {
    const host = this.host(base);
    return {
      ...base,
      ...host,
      realpath: (file) => this.#realpath(base, host, file),
      readFile: (file) => {
        this.script(file);
        const value = base.readFile(file);
        if (value !== undefined) this.member(file);
        return value;
      },
      getFileSize:
        base.getFileSize === undefined
          ? undefined
          : (file) => {
              this.add(file, 'content');
              return base.getFileSize!(file);
            },
      readDirectory: (...arguments_) => {
        // No unobserved directory enumeration can grant a complete receipt.
        this.#markIncomplete();
        return base.readDirectory(...arguments_);
      },
    } as typeof ts.sys;
  }

  generatedScript(file: string, value: unknown): void {
    this.generated[file] = analysisHash(value);
  }
}

function isLexicalRealpath(
  file: string,
  resolved: string | undefined,
): boolean {
  return (
    resolved !== undefined &&
    normalizeAbsolutePath(resolved) === normalizeAbsolutePath(file)
  );
}
