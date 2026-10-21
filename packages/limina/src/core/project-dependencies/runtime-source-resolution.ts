import { resolveCheckerSourceModuleName } from '#checkers';
import { normalizeAbsolutePath } from '#utils/path';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { ImportRecord } from '../import-analysis/records';
import { classifyImportRuntimeEvidence } from '../import-analysis/runtime-evidence';
import type { CanonicalImportResolutionEvidence } from '../import-analysis/types';
import { getSourceFileKind } from '../import-analysis/typescript-imports';
import {
  findImportRecordLiteral,
  isModuleImportRecord,
} from '../typescript-semantic/import-record';
import type { ProjectSemanticContext } from './contracts';

interface RuntimeSourceResolution {
  readonly mode: ts.ResolutionMode;
  readonly evidence: CanonicalImportResolutionEvidence;
}

/**
 * Source/runtime interpretation only; no Program membership or emit proof.
 */
export class RuntimeSourceResolver {
  readonly #project: ProjectSemanticContext;
  readonly #sources = new Map<string, ts.SourceFile>();
  readonly #cache: ts.ModuleResolutionCache;

  constructor(project: ProjectSemanticContext) {
    this.#project = project;
    this.#cache = ts.createModuleResolutionCache(
      path.dirname(project.configPath),
      (file) => file,
      project.compilerOptions,
    );
  }

  #source(file: string): ts.SourceFile {
    const previous = this.#sources.get(file);
    if (previous !== undefined) return previous;
    const source = ts.createSourceFile(
      file,
      this.#text(file),
      {
        languageVersion: ts.ScriptTarget.Latest,
        impliedNodeFormat: ts.getImpliedNodeFormatForFile(
          file as ts.Path,
          undefined,
          ts.sys,
          this.#project.compilerOptions,
        ),
      },
      true,
      getSourceFileKind(file),
    );
    this.#sources.set(file, source);
    return source;
  }

  #text(file: string): string {
    return this.#project.virtualFiles?.get(file) ?? readFileSync(file, 'utf8');
  }

  #mode(record: ImportRecord): ts.ResolutionMode {
    const source = this.#source(record.filePath);
    const literal = findImportRecordLiteral({
      importRecord: record,
      sourceFile: source,
      tsModule: ts,
    });
    return literal === null
      ? undefined
      : ts.getModeForUsageLocation(
          source,
          literal,
          this.#project.compilerOptions,
        );
  }

  resolve(record: ImportRecord): RuntimeSourceResolution | undefined {
    if (!isModuleImportRecord(record)) return undefined;
    const mode = this.#mode(record);
    const options = {
      specifier: record.specifier,
      containingFile: record.filePath,
      compilerOptions: this.#project.compilerOptions,
      extensions: [...this.#project.extensions],
    };
    const raw = ts.resolveModuleName(
      record.specifier,
      record.filePath,
      options.compilerOptions,
      ts.sys,
      this.#cache,
      undefined,
      mode,
    ).resolvedModule;
    const target =
      raw === undefined
        ? resolveCheckerSourceModuleName(options)
        : {
            resolvedBy: 'typescript' as const,
            resolvedFileName: normalizeAbsolutePath(raw.resolvedFileName),
            isExternalLibraryImport: raw.isExternalLibraryImport === true,
          };
    return {
      mode,
      evidence: {
        eligibility: {
          kind: 'not-applicable',
          reason:
            'Source/runtime resolution does not establish compilation obligations.',
        },
        oxcResolvedFilePath: null,
        typeScriptResolution: target,
        runtimeEvidence: classifyImportRuntimeEvidence({
          ...options,
          oxcResolvedFilePath: null,
          typeScriptResolution: target,
        }),
      },
    };
  }
}
