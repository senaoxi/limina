import type { VueProjectSemanticIdentity } from '#checkers';
import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import { analysisHash } from './identity';
import { inputStat } from './input-state';
import type { AnalysisInputs } from './inputs';
import { QueryTrace } from './query-trace';
import { observeVueTools } from './vue-toolchain-inputs';

export class VueInputTrace extends QueryTrace {
  readonly members: Set<string> = new Set<string>();
  readonly generated: Record<string, string> = {};

  constructor(inputs: AnalysisInputs, identity: VueProjectSemanticIdentity) {
    super(inputs);
    inputs.observeConfig(identity.configClosure);
    for (const entry of identity.configClosure) {
      this.add(entry.filePath, 'content');
      this.add(entry.filePath, 'binding');
    }
    for (const file of identity.fileNames) {
      this.add(file, 'content');
      this.add(file, 'binding');
    }
    const configurations =
      identity.declarationLoading?.coverage.configurations ?? [];
    for (const config of configurations) {
      this.add(config.configId, 'content');
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
    this.complete = [this.complete, isLexicalRealpath(file, resolved)].every(
      Boolean,
    );
    return resolved ?? file;
  }

  system(base: typeof ts.sys): typeof ts.sys {
    const host = this.host(base);
    return {
      ...base,
      ...host,
      realpath: (file) => this.#realpath(base, host, file),
      readFile: (file) => {
        const value = host.readFile(file);
        this.add(file, 'content');
        if (value !== undefined) this.members.add(file);
        return value;
      },
      readDirectory: (...arguments_) => {
        // No unobserved directory enumeration can grant a complete receipt.
        this.complete = false;
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
