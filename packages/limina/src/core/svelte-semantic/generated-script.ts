import { normalizeAbsolutePath } from '#utils/path';
import { TraceMap } from '@jridgewell/trace-mapping';
import path from 'node:path';
import type ts from 'typescript';
import { buildLineStarts } from '../import-analysis/records';
import { TypeScriptInclusionLedger } from '../typescript-semantic/admission';
import { prepareTypeScriptSupportInputs } from '../typescript-semantic/support-inputs';
import { createWorkspaceSourceBoundary } from '../typescript-semantic/workspace-source-boundary';
import { createSvelteResolutionHost } from './module-resolution';
import type { SvelteSemanticToolchain } from './toolchain';
import type { SvelteSemanticProject } from './types';

export interface GeneratedSemanticScript {
  resolutionHost: ts.ModuleResolutionHost;
  resolutionCache: ts.ModuleResolutionCache;
  filePath: string;
  lineStarts: readonly number[];
  sourceFile: ts.SourceFile;
  trace: TraceMap;
}

export function createGeneratedSemanticScript(options: {
  filePath: string;
  generated: ReturnType<SvelteSemanticToolchain['transform']>;
  toolchain: SvelteSemanticToolchain;
  project: SvelteSemanticProject;
}): GeneratedSemanticScript {
  const filePath = `${options.filePath}.tsx`;
  const resolutionHost = createSvelteResolutionHost(options.toolchain.tsModule);
  const sourceFile = options.toolchain.tsModule.createSourceFile(
    filePath,
    options.generated.code,
    options.toolchain.tsModule.ScriptTarget.Latest,
    true,
    options.toolchain.tsModule.ScriptKind.TSX,
  );
  sourceFile.impliedNodeFormat =
    options.toolchain.tsModule.getImpliedNodeFormatForFile(
      filePath as ts.Path,
      undefined,
      options.toolchain.tsModule.sys,
      options.project.options,
    );
  return {
    resolutionHost,
    resolutionCache: options.toolchain.tsModule.createModuleResolutionCache(
      path.dirname(options.project.configPath),
      (fileName) => fileName,
      options.project.options,
    ),
    filePath,
    lineStarts: buildLineStarts(options.generated.code),
    sourceFile,
    trace: new TraceMap({ ...options.generated.map, version: 3 as const }),
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
  const project = {
    configPath: options.project.configPath,
    fileNames: [
      ...nativeRoots,
      normalizeAbsolutePath(options.generated.filePath),
    ],
    options: options.project.options,
    workspaceSourceBoundary: createWorkspaceSourceBoundary([]),
  };
  const tsModule = options.toolchain.tsModule;
  const admission = new TypeScriptInclusionLedger(project, tsModule);
  const raw = createOverlayHost(options);
  const host: ts.CompilerHost = {
    ...raw,
    getSourceFile: (...arguments_) => {
      const file = arguments_[0];
      const isAllowed = isAdmittedSource(admission, file);
      return isAllowed ? raw.getSourceFile(...arguments_) : undefined;
    },
    resolveModuleNameLiterals: (...arguments_) => {
      const [
        literals,
        containingFile,
        redirected,
        compilerOptions,
        sourceFile,
      ] = arguments_;
      return literals.map((literal) => {
        const result = tsModule.resolveModuleName(
          literal.text,
          containingFile,
          compilerOptions,
          raw,
          undefined,
          redirected,
          tsModule.getModeForUsageLocation(
            sourceFile,
            literal,
            compilerOptions,
          ),
        );
        const target = result.resolvedModule;
        if (
          target === undefined ||
          admission.allowModuleTarget(target, containingFile)
        )
          return result;
        admission.exclude(target.resolvedFileName);
        return { ...result, resolvedModule: undefined };
      });
    },
  };
  let program: ts.Program;
  do {
    prepareTypeScriptSupportInputs({ admission, host: raw, project, tsModule });
    admission.beginProgram();
    program = tsModule.createProgram({
      host,
      options: project.options,
      rootNames: project.fileNames,
    });
    prepareTypeScriptSupportInputs({ admission, host: raw, project, tsModule });
  } while (admission.needsProgramRebuild());
  return program;
}

function isAdmittedSource(
  admission: TypeScriptInclusionLedger,
  file: string,
): boolean {
  const isAllowed = admission.has(file) || admission.allowDefaultLib(file);
  if (!isAllowed) admission.exclude(file);
  return isAllowed;
}
