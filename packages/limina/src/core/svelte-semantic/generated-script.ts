import { normalizeAbsolutePath } from '#utils/path';
import { TraceMap } from '@jridgewell/trace-mapping';
import path from 'node:path';
import type ts from 'typescript';
import { buildLineStarts } from '../import-analysis/records';
import type { SvelteSemanticToolchain } from './toolchain';
import type { SvelteSemanticProject } from './types';

export interface GeneratedSemanticScript {
  filePath: string;
  lineStarts: readonly number[];
  sourceFile: ts.SourceFile;
  trace: TraceMap;
}

export function createGeneratedSemanticScript(options: {
  filePath: string;
  generated: ReturnType<SvelteSemanticToolchain['transform']>;
  toolchain: SvelteSemanticToolchain;
}): GeneratedSemanticScript {
  const filePath = `${options.filePath}.tsx`;
  const sourceFile = options.toolchain.tsModule.createSourceFile(
    filePath,
    options.generated.code,
    options.toolchain.tsModule.ScriptTarget.Latest,
    true,
    options.toolchain.tsModule.ScriptKind.TSX,
  );
  return {
    filePath,
    lineStarts: buildLineStarts(options.generated.code),
    sourceFile,
    trace: new TraceMap(
      { ...options.generated.map, version: 3 as const },
      path.dirname(options.filePath),
    ),
  };
}

function createOverlayHost(options: {
  generated: GeneratedSemanticScript;
  project: SvelteSemanticProject;
  toolchain: SvelteSemanticToolchain;
}): ts.CompilerHost {
  const tsModule = options.toolchain.tsModule;
  const generatedPath = normalizeAbsolutePath(options.generated.filePath);
  const host = tsModule.createCompilerHost(options.project.options, true);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (fileName) =>
    normalizeAbsolutePath(fileName) === generatedPath || fileExists(fileName);
  host.readFile = (fileName) =>
    normalizeAbsolutePath(fileName) === generatedPath
      ? options.generated.sourceFile.text
      : readFile(fileName);
  host.getSourceFile = (...arguments_) =>
    normalizeAbsolutePath(arguments_[0]) === generatedPath
      ? options.generated.sourceFile
      : getSourceFile(...arguments_);
  return host;
}

export function createBoundedProgram(options: {
  generated: GeneratedSemanticScript;
  project: SvelteSemanticProject;
  toolchain: SvelteSemanticToolchain;
}): ts.Program {
  const nativeRoots = options.project.fileNames.filter(
    (fileName) => !/\.(?:astro|svelte|vue)$/iu.test(fileName),
  );
  return options.toolchain.tsModule.createProgram({
    host: createOverlayHost(options),
    options: options.project.options,
    rootNames: [
      ...nativeRoots,
      normalizeAbsolutePath(options.generated.filePath),
    ],
  });
}
