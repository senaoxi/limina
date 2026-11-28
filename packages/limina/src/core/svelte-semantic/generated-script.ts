import { readAnalysisInput } from '#utils/analysis-input';
import { normalizeAbsolutePath } from '#utils/path';
import { TraceMap } from '@jridgewell/trace-mapping';
import path from 'node:path';
import type ts from 'typescript';
import { currentProfile } from '../../application/analysis/observability';
import { observeWork, profileContextScope } from '../analysis-profile';
import {
  type FrameworkCompilerRequest,
  FrameworkCompilerRequests,
} from '../framework-semantic/compiler-requests';
import type { FrameworkRuntimeModuleResolver } from '../framework-semantic/runtime-dependencies';
import { buildLineStarts } from '../import-analysis/records';
import { TypeScriptInclusionLedger } from '../typescript-semantic/admission';
import { observeNativeHostInputs } from '../typescript-semantic/native-host-inputs';
import { observedResolutionHost } from '../typescript-semantic/observed-resolution-host';
import { getCompilerReferenceForModuleQuery } from '../typescript-semantic/reference-redirect';
import { resolveModuleWithOrigin } from '../typescript-semantic/resolution-origin';
import { runtimeModuleResolutionMode } from '../typescript-semantic/runtime-module-queries';
import { prepareTypeScriptSupportInputs } from '../typescript-semantic/support-inputs';
import { withVirtualResolutionFiles } from '../typescript-semantic/virtual-resolution-host';
import { createWorkspaceSourceBoundary } from '../typescript-semantic/workspace-source-boundary';
import { createSvelteResolutionHost } from './module-resolution';
import type { SvelteSemanticToolchain } from './toolchain';
import type { SvelteSemanticProject } from './types';

export interface GeneratedSemanticScript {
  compilerRequests: FrameworkCompilerRequests;
  boundedProgram?: SvelteBoundedProgram;
  resolutionHost: ts.ModuleResolutionHost;
  resolutionCache: ts.ModuleResolutionCache;
  filePath: string;
  lineStarts: readonly number[];
  sourceFile: ts.SourceFile;
  trace: TraceMap;
}

interface SvelteBoundedProgram {
  compilerRequests: FrameworkCompilerRequests;
  program: ts.Program;
  resolveRuntimeModule: FrameworkRuntimeModuleResolver;
}

export function createGeneratedSemanticScript(options: {
  filePath: string;
  generated: Pick<
    ReturnType<SvelteSemanticToolchain['transform']>,
    'code' | 'map'
  >;
  toolchain: SvelteSemanticToolchain;
  project: SvelteSemanticProject;
}): GeneratedSemanticScript {
  const filePath = `${options.filePath}.tsx`;
  const resolutionHost = withVirtualResolutionFiles(
    createSvelteResolutionHost(options.toolchain.tsModule),
    options.project.virtualFiles,
  );
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
      observedResolutionHost(
        options.toolchain.tsModule,
        options.project.configPath,
      ),
      options.project.options,
    );
  return {
    compilerRequests: new FrameworkCompilerRequests(
      options.toolchain.tsModule,
      options.project.configPath,
    ),
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
  generated?: GeneratedSemanticScript;
  project: SvelteSemanticProject;
  toolchain: SvelteSemanticToolchain;
}): ts.CompilerHost {
  const tsModule = options.toolchain.tsModule;
  const generatedPath = options.generated?.filePath;
  const physical = tsModule.createCompilerHost(options.project.options, true);
  observeNativeHostInputs(physical);
  const host = withVirtualResolutionFiles(
    physical,
    options.project.virtualFiles,
  );
  if (options.project.references !== undefined)
    (
      host as ts.CompilerHost & {
        useSourceOfProjectReferenceRedirect(): boolean;
      }
    ).useSourceOfProjectReferenceRedirect = () => true;
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  const componentHost = createSvelteResolutionHost(tsModule);
  host.fileExists = (fileName) =>
    normalizeAbsolutePath(fileName) === generatedPath ||
    fileExists(fileName) ||
    componentHost.fileExists(fileName);
  host.readFile = (fileName) =>
    options.generated !== undefined &&
    normalizeAbsolutePath(fileName) === generatedPath
      ? options.generated.sourceFile.text
      : readFile(fileName);
  host.getSourceFile = (...arguments_) => {
    const name = normalizeAbsolutePath(arguments_[0]);
    if (name === generatedPath && options.generated !== undefined)
      return options.generated.sourceFile;
    const text = options.project.virtualFiles?.get(name);
    return text === undefined
      ? getSourceFile(...arguments_)
      : tsModule.createSourceFile(name, text, arguments_[1], true);
  };
  return host;
}

/** Native roots in a Svelte execution view still issue real Compiler requests.
 * The component host qualifies source associations without loading foreign
 * implementations into the bounded Program. */
export function observeSvelteNativeComponentRequests(
  project: SvelteSemanticProject,
  toolchain: SvelteSemanticToolchain,
): FrameworkCompilerRequest[] {
  if (project.options.noResolve) return [];
  return project.fileNames
    .filter(
      (file) => /\.[cm]?[jt]sx?$/iu.test(file) && !/\.d\.[cm]?ts$/iu.test(file),
    )
    .flatMap((file) => {
      const sourceFile = toolchain.tsModule.createSourceFile(
        file,
        readAnalysisInput(
          file,
          () => toolchain.tsModule.sys.readFile(file),
          'typescript-content',
        )!,
        toolchain.tsModule.ScriptTarget.Latest,
        true,
      );
      const generated: GeneratedSemanticScript = {
        compilerRequests: new FrameworkCompilerRequests(
          toolchain.tsModule,
          project.configPath,
        ),
        filePath: file,
        sourceFile,
        lineStarts: buildLineStarts(sourceFile.text),
        resolutionHost: withVirtualResolutionFiles(
          createSvelteResolutionHost(toolchain.tsModule),
          project.virtualFiles,
        ),
        resolutionCache: toolchain.tsModule.createModuleResolutionCache(
          path.dirname(project.resolverConfigPath),
          (name) => name,
          project.options,
        ),
        trace: new TraceMap({
          version: 3,
          sources: [],
          names: [],
          mappings: '',
        }),
      };
      const { program } = createBoundedProgram({
        generated,
        project,
        toolchain,
      });
      return generated.compilerRequests
        .collect(program, sourceFile)
        .filter(
          (request) => request.role === 'import' && request.raw !== undefined,
        );
    });
}

export function createBoundedProgram(options: {
  generated?: GeneratedSemanticScript;
  project: SvelteSemanticProject;
  toolchain: SvelteSemanticToolchain;
}): SvelteBoundedProgram {
  if (options.generated?.boundedProgram !== undefined)
    return options.generated.boundedProgram;
  const nativeRoots = options.project.fileNames.filter(
    (fileName) => !/\.(?:astro|svelte|vue)$/iu.test(fileName),
  );
  const project = {
    configPath: options.project.configPath,
    fileNames: [
      ...nativeRoots,
      ...(options.generated === undefined ? [] : [options.generated.filePath]),
    ],
    options: options.project.options,
    workspaceSourceBoundary: createWorkspaceSourceBoundary([]),
  };
  const tsModule = options.toolchain.tsModule;
  const compilerRequests =
    options.generated?.compilerRequests ??
    new FrameworkCompilerRequests(tsModule, project.configPath);
  const admission = new TypeScriptInclusionLedger(project, tsModule);
  const raw = createOverlayHost(options);
  const resolve = (
    specifier: string,
    containingFile: string,
    compilerOptions: ts.CompilerOptions,
    redirect: ts.ResolvedProjectReference | undefined,
    mode: ts.ResolutionMode,
  ) =>
    resolveModuleWithOrigin(
      tsModule,
      specifier,
      containingFile,
      compilerOptions,
      raw,
      undefined,
      redirect,
      mode,
    );
  const host: ts.CompilerHost = {
    ...raw,
    getSourceFile: (...arguments_) => {
      const file = arguments_[0];
      const isAllowed =
        (file.endsWith('.json') &&
          options.project.virtualFiles?.has(normalizeAbsolutePath(file))) ||
        isAdmittedSource(admission, file);
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
        const result = resolve(
          literal.text,
          containingFile,
          compilerOptions,
          redirected,
          tsModule.getModeForUsageLocation(
            sourceFile,
            literal,
            compilerOptions,
          ),
        );
        compilerRequests.observe({
          source: sourceFile,
          literal,
          options: compilerOptions,
          redirect: redirected,
          result,
        });
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
  const observer = currentProfile();
  const scope =
    observer === undefined
      ? undefined
      : profileContextScope(observer, {
          instance: options.generated ?? options.project,
          configPath: project.configPath,
          checker: 'svelte-check',
          provider: 'svelte',
          role: options.generated === undefined ? 'source' : 'component',
        });
  let pass = 0;
  do {
    prepareTypeScriptSupportInputs({ admission, host: raw, project, tsModule });
    admission.beginProgram();
    const request = {
      host,
      options: project.options,
      rootNames: project.fileNames,
      projectReferences:
        options.project.references === undefined
          ? undefined
          : [...options.project.references],
    };
    program =
      observer === undefined
        ? tsModule.createProgram(request)
        : observeWork(
            observer,
            'svelte-program-create',
            () => tsModule.createProgram(request),
            scope,
            ++pass,
            'computed',
          );
    prepareTypeScriptSupportInputs({ admission, host: raw, project, tsModule });
  } while (admission.needsProgramRebuild());
  const bounded: SvelteBoundedProgram = {
    compilerRequests,
    program,
    resolveRuntimeModule(source, literal, occurrence) {
      const redirect = getCompilerReferenceForModuleQuery(
        program,
        source,
        tsModule,
        raw.realpath,
      );
      const compilerOptions =
        redirect?.commandLine.options ?? program.getCompilerOptions();
      const mode = runtimeModuleResolutionMode({
        compiler: tsModule,
        source,
        literal,
        options: compilerOptions,
        occurrence,
      });
      return {
        mode,
        resolved: resolve(
          literal.text,
          source.fileName,
          compilerOptions,
          redirect,
          mode,
        ).resolvedModule,
      };
    },
  };
  if (options.generated !== undefined)
    options.generated.boundedProgram = bounded;
  return bounded;
}

function isAdmittedSource(
  admission: TypeScriptInclusionLedger,
  file: string,
): boolean {
  const isAllowed = admission.has(file) || admission.allowDefaultLib(file);
  if (!isAllowed) admission.exclude(file);
  return isAllowed;
}
