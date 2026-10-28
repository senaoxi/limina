import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import type { GeneratedSemanticDependency } from '../framework-semantic/generated-dependencies';
import type { ImportRecord } from '../import-analysis/records';
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
  redirect: ts.ResolvedProjectReference | undefined;
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
  #raw = new WeakMap<
    ts.SourceFile,
    Map<string, ts.ResolvedModuleWithFailedLookupLocations>
  >();
  #files = new WeakMap<ts.SourceFile, VueCompilerRequest[]>();
  readonly optionsBySource: Map<ts.SourceFile, ts.CompilerOptions> = new Map();
  readonly compiler: typeof ts;
  readonly configPath: string;
  constructor(compiler: typeof ts, configPath: string) {
    this.compiler = compiler;
    this.configPath = configPath;
  }
  observeOptions(
    input: Pick<Resolution, 'source' | 'options' | 'redirect'>,
  ): void {
    this.optionsBySource.set(
      input.source,
      input.redirect?.commandLine.options ?? input.options,
    );
  }
  dispose(): void {
    this.optionsBySource.clear();
    this.#raw = new WeakMap();
    this.#files = new WeakMap();
  }
  observe(input: Resolution): void {
    this.observeOptions(input);
    const mode = this.compiler.getModeForUsageLocation(
      input.source,
      input.literal,
      this.optionsBySource.get(input.source)!,
    );
    const raw = this.#raw.get(input.source) ?? new Map();
    raw.set(key(input.source, input.literal, mode), input.result);
    this.#raw.set(input.source, raw);
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
    const observed = nativeObservedProgram(
      program,
      this.compiler,
      this.optionsBySource,
    );
    const occurrences = new Map<string, number>();
    const requests = entries.map(({ literal, role }) => {
      const options = observed.getCompilerOptionsForFile(source);
      const mode =
        options === undefined
          ? program.getModeForUsageLocation(source, literal)
          : this.compiler.getModeForUsageLocation(source, literal, options);
      const record: ImportRecord = {
        ...compilerModuleRecord(source, literal, role, this.compiler),
        ...(literal.pos < 0 &&
          options !== undefined &&
          syntheticModuleMetadata({
            compiler: this.compiler,
            options,
            configPath: this.configPath,
            source,
            literal,
            mode,
          })),
      };
      const identity = JSON.stringify([record.kind, record.specifier]);
      record.locator.occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, record.locator.occurrence + 1);
      record.compilerRequest = {
        contextConfig: this.configPath,
        fileName: normalizeAbsolutePath(source.fileName),
        role,
        mode,
        occurrence: record.locator.occurrence,
        start: record.locator.sourceStart,
        end: record.locator.sourceEnd,
      };
      return {
        sourceFile: source,
        generatedFilePath: normalizeAbsolutePath(source.fileName),
        literal,
        role,
        mode,
        record,
        raw:
          this.#raw.get(source)?.get(key(source, literal, mode)) ??
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

export function isMatchingVueCompilerRequest(
  request: VueCompilerRequest,
  record: ImportRecord,
): boolean {
  const identity = record.compilerRequest;
  const actual = request.record.compilerRequest;
  return (
    identity !== undefined &&
    actual !== undefined &&
    record.specifier === request.record.specifier &&
    identity.contextConfig === actual.contextConfig &&
    identity.fileName === actual.fileName &&
    identity.role === actual.role &&
    identity.mode === actual.mode &&
    identity.occurrence === actual.occurrence &&
    identity.start === actual.start &&
    identity.end === actual.end
  );
}
