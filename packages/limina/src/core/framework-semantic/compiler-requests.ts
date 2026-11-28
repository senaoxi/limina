import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import type { ImportRecord } from '../import-analysis/records';
import { compilerModuleRecord } from '../typescript-semantic/compiler-module-record';
import {
  nativeObservedProgram,
  nativeProgramSource,
} from '../typescript-semantic/native-program-api';
import { syntheticModuleMetadata } from '../typescript-semantic/native-program-synthetic';
import type { GeneratedSemanticDependency } from './generated-dependencies';

export interface FrameworkTypeResolution {
  source: ts.SourceFile | undefined;
  reference: ts.FileReference | string;
  options: ts.CompilerOptions;
  redirect: ts.ResolvedProjectReference | undefined;
  mode: ts.ResolutionMode;
  result: ts.ResolvedTypeReferenceDirectiveWithFailedLookupLocations;
}

interface Resolution {
  source: ts.SourceFile;
  literal: ts.StringLiteralLike;
  options: ts.CompilerOptions;
  redirect: ts.ResolvedProjectReference | undefined;
  result: ts.ResolvedModuleWithFailedLookupLocations;
}
export interface FrameworkCompilerRequest extends GeneratedSemanticDependency {
  literal: ts.StringLiteralLike;
  role: 'import' | 'augmentation';
  mode: ts.ResolutionMode;
  raw: ts.ResolvedModuleWithFailedLookupLocations | undefined;
  ambient: boolean;
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
export class FrameworkCompilerRequests {
  #raw = new WeakMap<
    ts.SourceFile,
    Map<string, ts.ResolvedModuleWithFailedLookupLocations>
  >();
  #files = new WeakMap<ts.SourceFile, FrameworkCompilerRequest[]>();
  #byOccurrence = new WeakMap<
    ts.SourceFile,
    Map<string, FrameworkCompilerRequest[]>
  >();
  #importsByStart = new WeakMap<
    ts.SourceFile,
    Map<number, FrameworkCompilerRequest>
  >();
  readonly typeResolutions: FrameworkTypeResolution[] = [];
  readonly moduleResolutions: Resolution[] = [];
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
    this.typeResolutions.length = 0;
    this.moduleResolutions.length = 0;
    this.#raw = new WeakMap();
    this.#files = new WeakMap();
    this.#byOccurrence = new WeakMap();
    this.#importsByStart = new WeakMap();
  }
  observeType(input: FrameworkTypeResolution): void {
    this.typeResolutions.push(input);
    if (input.source !== undefined)
      this.observeOptions({ ...input, source: input.source });
  }
  observe(input: Resolution): void {
    this.moduleResolutions.push(input);
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
  matching(
    program: ts.Program,
    record: ImportRecord,
  ): readonly FrameworkCompilerRequest[] {
    const id = record.compilerRequest;
    if (id === undefined || id.contextConfig !== this.configPath) return [];
    const source = program.getSourceFile(id.fileName);
    if (
      source === undefined ||
      normalizeAbsolutePath(source.fileName) !== id.fileName
    )
      return [];
    let entries = this.#byOccurrence.get(source);
    if (entries === undefined) {
      entries = Map.groupBy(this.collect(program, source), (request) =>
        occurrenceId(request.record.specifier, request.record.compilerRequest!),
      );
      this.#byOccurrence.set(source, entries);
    }
    return entries.get(occurrenceId(record.specifier, id)) ?? [];
  }

  sourceImport(
    program: ts.Program,
    source: ts.SourceFile,
    record: ImportRecord,
  ): FrameworkCompilerRequest | undefined {
    let imports = this.#importsByStart.get(source);
    if (imports === undefined) {
      imports = new Map();
      for (const request of this.collect(program, source)) {
        const start = request.record.locator.sourceStart;
        if (request.role === 'import' && start >= 0)
          imports.set(start, request);
      }
      this.#importsByStart.set(source, imports);
    }
    const match = imports.get(record.locator.sourceStart);
    return match?.record.specifier === record.specifier &&
      match.record.locator.sourceEnd === record.locator.sourceEnd
      ? match
      : undefined;
  }

  collect(
    program: ts.Program,
    source: ts.SourceFile,
  ): FrameworkCompilerRequest[] {
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
        ambient: inventory.ambientModuleNames.includes(literal.text),
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

function occurrenceId(
  specifier: string,
  id: NonNullable<ImportRecord['compilerRequest']>,
): string {
  return JSON.stringify([
    specifier,
    id.role,
    id.mode,
    id.occurrence,
    id.start,
    id.end,
  ]);
}
