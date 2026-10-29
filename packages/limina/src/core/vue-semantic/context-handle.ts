import type {
  VolarLanguage,
  VolarSourceScript,
  VueLanguageServiceHost,
  VueProjectSemanticIdentity,
} from '#checkers';
import path from 'node:path';
import type ts from 'typescript';
import {
  createVueOverlaySystem,
  parseVueConfigWithToolchain,
} from '../../checker/vue-semantic-identity';
import { createUnsupportedVueToolchainCompatibilityError } from '../../checker/vue-semantic-toolchain';
import { observeVueExecutionSystem } from '../analysis-cache/vue-execution-inputs';
import type { VueInputTrace } from '../analysis-cache/vue-inputs';
import { declarationLoadingCeiling } from '../declaration-governance/loading';
import { createBoundedLanguageServiceHost } from '../framework-semantic/bounded-host';
import { originTracingCompiler } from '../typescript-semantic/resolution-origin';
import { createWorkspaceSourceBoundary } from '../typescript-semantic/workspace-source-boundary';
import { VueCompilerRequests } from './compiler-requests';
import {
  createMeasuredProgram,
  getCachedSemanticSourceFile,
  type ProgramCreationObserver,
} from './context-lazy-state';
import { resolveModuleNameLiteralMap } from './context-resolution';
interface SnapshotEntry {
  snapshot: ts.IScriptSnapshot;
  text: string;
}
interface VueScriptStore {
  language: VolarLanguage | undefined;
  snapshots: Map<string, SnapshotEntry>;
  texts: Map<string, string>;
}
const languageIdPatterns: readonly [RegExp, string][] = [
  [/\.(?:cts|mts|ts)$/iu, 'typescript'],
  [/\.tsx$/iu, 'typescriptreact'],
  [/\.(?:cjs|js|mjs)$/iu, 'javascript'],
  [/\.jsx$/iu, 'javascriptreact'],
  [/\.json$/iu, 'json'],
];

function getLanguageId(fileName: string): string | undefined {
  return languageIdPatterns.find(([pattern]) => pattern.test(fileName))?.[1];
}

function deleteLanguageScript(
  language: VolarLanguage | undefined,
  id: string,
): void {
  if (language === undefined) return;
  language.scripts.delete(id);
}

function removeMissingScript(store: VueScriptStore, id: string): void {
  if (!store.snapshots.has(id)) return;
  store.snapshots.delete(id);
  deleteLanguageScript(store.language, id);
}

function hasSameText(
  current: SnapshotEntry | undefined,
  text: string,
): boolean {
  return current !== undefined && current.text === text;
}

function registerLanguageScript(options: {
  id: string;
  language: VolarLanguage | undefined;
  snapshot: ts.IScriptSnapshot;
}): void {
  if (options.language === undefined) return;
  options.language.scripts.set(
    options.id,
    options.snapshot,
    getLanguageId(options.id),
  );
}

function updateScript(options: {
  id: string;
  store: VueScriptStore;
  text: string;
  tsModule: typeof ts;
}): void {
  const current = options.store.snapshots.get(options.id);
  if (hasSameText(current, options.text)) return;
  const snapshot = options.tsModule.ScriptSnapshot.fromString(options.text);
  options.store.snapshots.set(options.id, { snapshot, text: options.text });
  registerLanguageScript({
    id: options.id,
    language: options.store.language,
    snapshot,
  });
}

function syncScript(options: {
  id: string;
  store: VueScriptStore;
  sys: typeof ts.sys;
  tsModule: typeof ts;
}): void {
  const text =
    options.store.texts.get(options.id) ?? options.sys.readFile(options.id);
  if (text === undefined) {
    removeMissingScript(options.store, options.id);
    return;
  }
  // Missing inputs can appear during toolchain preparation; only retain text.
  options.store.texts.set(options.id, text);
  updateScript({ ...options, text });
}

function createProjectHost(identity: VueProjectSemanticIdentity) {
  // Volar enables non-TS extensions on these options. Keep parser identity
  // and other semantic providers isolated from that host-local mutation.
  const options = { ...identity.options };
  return {
    getCompilationSettings: () => options,
    getCurrentDirectory: () => path.dirname(identity.configPath),
    getProjectReferences: () => identity.projectReferences,
    getProjectVersion: () => `${identity.generation}:${identity.id}`,
    getScriptFileNames: () => [...identity.fileNames],
  };
}

function disposeLanguage(options: {
  language: VolarLanguage;
  languageService: ts.LanguageService;
  scriptRegistry: Map<string, VolarSourceScript>;
  snapshots: Map<string, SnapshotEntry>;
}): void {
  options.languageService.dispose();
  for (const id of options.snapshots.keys()) {
    options.language.scripts.delete(id);
  }
  options.snapshots.clear();
  options.scriptRegistry.clear();
}

export class VueSemanticContext {
  readonly #onProgramCreated: ProgramCreationObserver | undefined;

  #program: ts.Program | undefined;

  readonly #semanticSourceFiles = new Map<string, ts.SourceFile>();

  readonly #scriptRegistry: Map<string, VolarSourceScript>;

  readonly #snapshots: Map<string, SnapshotEntry>;

  readonly #texts = new Map<string, string>();

  readonly #boundedHost: ReturnType<typeof createBoundedLanguageServiceHost>;

  #disposed = false;

  readonly resolveSupplementalModule:
    | ((
        name: string,
        importer: string,
        options: ts.CompilerOptions,
        mode: ts.ResolutionMode,
      ) => ts.ResolvedModuleWithFailedLookupLocations)
    | undefined;

  readonly compilerRequests: VueCompilerRequests;

  readonly identity: VueProjectSemanticIdentity;

  readonly language: VolarLanguage;

  languageService: ts.LanguageService;

  readonly languageServiceHost: VueLanguageServiceHost;

  readonly sys: typeof ts.sys;

  readonly tsModule: typeof ts;

  readonly analysisTrace: VueInputTrace | undefined;

  constructor(
    identity: VueProjectSemanticIdentity,
    onProgramCreated?: ProgramCreationObserver,
    analysisTrace?: VueInputTrace,
  ) {
    if (identity.toolchain.adapter.kind === 'unsupported') {
      throw createUnsupportedVueToolchainCompatibilityError({
        checkerExecutionRootDir: identity.projectRootDir,
        tuple: identity.toolchain.versions,
      });
    }
    this.identity = identity;
    this.analysisTrace = analysisTrace;
    this.#onProgramCreated = onProgramCreated;
    this.tsModule = identity.toolchain.tsModule;
    this.compilerRequests = new VueCompilerRequests(
      this.tsModule,
      identity.configPath,
    );
    const sys = createVueOverlaySystem({
      tsModule: this.tsModule,
      virtualFiles: identity.virtualFiles,
    });
    this.sys = observeVueExecutionSystem(identity, sys, analysisTrace);
    const plugin = identity.toolchain.languageCore.createVueLanguagePlugin(
      this.tsModule,
      identity.options,
      identity.vueOptions,
      (scriptId) => scriptId,
    );
    this.#scriptRegistry = new Map();
    const store: VueScriptStore = {
      language: undefined,
      snapshots: new Map(),
      texts: this.#texts,
    };
    this.language = identity.toolchain.languageCore.createLanguage(
      [plugin],
      this.#scriptRegistry,
      (id) => syncScript({ id, store, sys: this.sys, tsModule: this.tsModule }),
    );
    store.language = this.language;
    const resolve =
      identity.toolchain.volarTypeScript.createResolveModuleName?.(
        this.tsModule,
        (file) => this.sys.getFileSize?.(file),
        this.sys,
        [plugin],
        (file) => this.language.scripts.get(file),
      );
    this.resolveSupplementalModule =
      resolve === undefined
        ? undefined
        : (name, importer, options, mode) =>
            resolve(name, importer, options, undefined, undefined, mode);

    this.#snapshots = store.snapshots;
    const hostResult =
      identity.toolchain.volarTypeScript.createLanguageServiceHost(
        originTracingCompiler(this.tsModule),
        this.sys,
        this.language,
        (fileName) => fileName,
        createProjectHost(identity),
      );
    hostResult.languageServiceHost.getProjectVersion = () =>
      `${identity.generation}:${identity.id}`;
    this.languageServiceHost = hostResult.languageServiceHost;
    this.languageServiceHost.getParsedCommandLine = (file) =>
      parseVueConfigWithToolchain({
        configPath: file,
        extensions: identity.extensions,
        host: this.sys,
        toolchain: identity.toolchain,
      });
    this.#boundedHost = createBoundedLanguageServiceHost({
      host: this.languageServiceHost,
      observeModule: (input) => this.compilerRequests.observe(input),
      observeType: (input) => this.compilerRequests.observeType(input),
      observeOptions: (input) => this.compilerRequests.observeOptions(input),
      tsModule: this.tsModule,
      project: {
        loadingCeiling:
          identity.declarationLoading === undefined
            ? undefined
            : declarationLoadingCeiling(
                identity.declarationLoading,
                identity.fileNames,
              ),
        configPath: identity.configPath,
        fileNames: identity.fileNames,
        options: identity.options,
        projectReferences: identity.projectReferences,
        virtualFiles: identity.virtualFiles,
        workspaceSourceBoundary: createWorkspaceSourceBoundary([]),
      },
    });
    this.languageService = this.tsModule.createLanguageService(
      this.#boundedHost.host,
    );
  }

  #createProgram(): ts.Program {
    do {
      this.#boundedHost.begin();
      const program = createMeasuredProgram({
        languageService: this.languageService,
        observer: this.#onProgramCreated,
      });
      if (!this.#boundedHost.needsRebuild()) return program;
      this.languageService.dispose();
      this.languageService = this.tsModule.createLanguageService(
        this.#boundedHost.host,
      );
    } while (true);
  }

  get program(): ts.Program {
    this.assertActive();
    this.#program ??= this.#createProgram();
    return this.#program;
  }

  getSemanticSourceFile(fileName: string): ts.SourceFile | undefined {
    this.assertActive();
    const normalizedFileName = path.resolve(fileName);
    return getCachedSemanticSourceFile({
      cache: this.#semanticSourceFiles,
      fileName: normalizedFileName,
      host: this.languageServiceHost,
      identity: this.identity,
      tsModule: this.tsModule,
    });
  }

  assertActive(): void {
    if (this.#disposed) {
      throw new Error('Vue semantic context was disposed.');
    }
  }

  resolveModuleNameLiterals(
    literals: readonly ts.StringLiteralLike[],
  ): ReturnType<typeof resolveModuleNameLiteralMap> {
    this.assertActive();
    return resolveModuleNameLiteralMap({
      compilerOptions: this.identity.options,
      host: this.languageServiceHost,
      literals,
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#program = undefined;
    this.compilerRequests.dispose();
    this.#semanticSourceFiles.clear();
    this.#texts.clear();
    disposeLanguage({
      language: this.language,
      languageService: this.languageService,
      scriptRegistry: this.#scriptRegistry,
      snapshots: this.#snapshots,
    });
  }
}
