import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import type { GeneratedSemanticDependency } from '../framework-semantic/generated-dependencies';
import { compilerModuleRecord } from '../typescript-semantic/compiler-module-record';
import {
  nativeObservedProgram,
  nativeProgramSource,
} from '../typescript-semantic/native-program-api';
import { syntheticModuleMetadata } from '../typescript-semantic/native-program-synthetic';

interface Resolution {
  source: ts.SourceFile;
  literal: ts.StringLiteralLike;
  options: ts.CompilerOptions;
  result: ts.ResolvedModuleWithFailedLookupLocations;
}
export interface VueCompilerRequest extends GeneratedSemanticDependency {
  literal: ts.StringLiteralLike;
  role: 'import' | 'augmentation';
  mode: ts.ResolutionMode;
  raw: ts.ResolvedModuleWithFailedLookupLocations | undefined;
}
function key(
  source: ts.SourceFile,
  literal: ts.StringLiteralLike,
  mode: ts.ResolutionMode,
): string {
  return JSON.stringify([
    source.fileName,
    literal.pos,
    literal.end,
    literal.text,
    mode,
  ]);
}
/**
Only the Program-facing bounded host records raw resolution here.
*/
export class VueCompilerRequests {
  readonly #raw = new Map<string, ts.ResolvedModuleWithFailedLookupLocations>();
  readonly #files = new WeakMap<ts.SourceFile, VueCompilerRequest[]>();
  readonly compiler: typeof ts;
  readonly configPath: string;
  constructor(compiler: typeof ts, configPath: string) {
    this.compiler = compiler;
    this.configPath = configPath;
  }
  observe(input: Resolution): void {
    const mode = this.compiler.getModeForUsageLocation(
      input.source,
      input.literal,
      input.options,
    );
    this.#raw.set(key(input.source, input.literal, mode), input.result);
  }
  collect(program: ts.Program, source: ts.SourceFile): VueCompilerRequest[] {
    const cached = this.#files.get(source);
    if (cached !== undefined) return cached;
    const inventory = nativeProgramSource(source);
    const entries = [
      ...inventory.imports.map((literal) => ({
        literal,
        role: 'import' as const,
      })),
      ...inventory.moduleAugmentations
        .filter(this.compiler.isStringLiteral)
        .map((literal) => ({ literal, role: 'augmentation' as const })),
    ];
    const observed = nativeObservedProgram(program, this.compiler, new Map());
    const occurrences = new Map<string, number>();
    const requests = entries.map(({ literal, role }) => {
      const mode = program.getModeForUsageLocation(source, literal);
      const record = {
        ...compilerModuleRecord(source, literal, role, this.compiler),
        ...(literal.pos < 0 &&
          syntheticModuleMetadata({
            compiler: this.compiler,
            options: program.getCompilerOptions(),
            configPath: this.configPath,
            source,
            literal,
            mode,
          })),
      };
      const identity = JSON.stringify([record.kind, record.specifier]);
      record.locator.occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, record.locator.occurrence + 1);
      return {
        sourceFile: source,
        generatedFilePath: normalizeAbsolutePath(source.fileName),
        literal,
        role,
        mode,
        record,
        raw:
          this.#raw.get(key(source, literal, mode)) ??
          reusedResolution(
            observed.getResolvedModule(source, literal.text, mode),
          ),
      };
    });
    this.#files.set(source, requests);
    return requests;
  }
}

function reusedResolution(
  result: ts.ResolvedModuleWithFailedLookupLocations | undefined,
) {
  // A missing callback may reflect compiler reuse. A masked miss cannot prove
  // a completed unresolved request; retain unknown unless the target survived.
  return result?.resolvedModule === undefined ? undefined : result;
}
