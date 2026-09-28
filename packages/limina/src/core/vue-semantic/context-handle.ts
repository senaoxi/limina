import type {
  VolarLanguage,
  VolarSourceScript,
  VueLanguageServiceHost,
  VueProjectSemanticIdentity,
} from '#checkers';
import path from 'node:path';
import type ts from 'typescript';
import { createVueOverlaySystem } from '../../checker/vue-semantic-identity';
import { createUnsupportedVueToolchainCompatibilityError } from '../../checker/vue-semantic-toolchain';
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
  if (current === undefined) return false;
  return current.text === text;
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
  const text = options.sys.readFile(options.id);
  if (text === undefined) {
    removeMissingScript(options.store, options.id);
    return;
  }
  updateScript({ ...options, text });
}

function createProjectHost(identity: VueProjectSemanticIdentity) {
  return {
    getCompilationSettings: () => identity.options,
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
  readonly identity: VueProjectSemanticIdentity;
  readonly language: VolarLanguage;
  readonly languageService: ts.LanguageService;
  readonly languageServiceHost: VueLanguageServiceHost;
  readonly sys: typeof ts.sys;
  readonly tsModule: typeof ts;
  readonly #onProgramCreated: ProgramCreationObserver | undefined;
  #program: ts.Program | undefined;
  readonly #semanticSourceFiles = new Map<string, ts.SourceFile>();
  readonly #scriptRegistry: Map<string, VolarSourceScript>;
  readonly #snapshots: Map<string, SnapshotEntry>;
  #disposed = false;

  constructor(
    identity: VueProjectSemanticIdentity,
    onProgramCreated?: ProgramCreationObserver,
  ) {
    if (identity.toolchain.adapter.kind === 'unsupported') {
      throw createUnsupportedVueToolchainCompatibilityError({
        checkerExecutionRootDir: identity.projectRootDir,
        tuple: identity.toolchain.versions,
      });
    }
    this.identity = identity;
    this.#onProgramCreated = onProgramCreated;
    this.tsModule = identity.toolchain.tsModule;
    this.sys = createVueOverlaySystem({
      tsModule: this.tsModule,
      virtualFiles: identity.virtualFiles,
    });
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
    };
    this.language = identity.toolchain.languageCore.createLanguage(
      [plugin],
      this.#scriptRegistry,
      (id) => syncScript({ id, store, sys: this.sys, tsModule: this.tsModule }),
    );
    store.language = this.language;
    this.#snapshots = store.snapshots;
    const hostResult =
      identity.toolchain.volarTypeScript.createLanguageServiceHost(
        this.tsModule,
        this.sys,
        this.language,
        (fileName) => fileName,
        createProjectHost(identity),
      );
    hostResult.languageServiceHost.getProjectVersion = () =>
      `${identity.generation}:${identity.id}`;
    this.languageServiceHost = hostResult.languageServiceHost;
    this.languageService = this.tsModule.createLanguageService(
      this.languageServiceHost,
    );
  }

  get program(): ts.Program {
    this.assertActive();
    this.#program ??= createMeasuredProgram({
      languageService: this.languageService,
      observer: this.#onProgramCreated,
    });
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
    this.#semanticSourceFiles.clear();
    disposeLanguage({
      language: this.language,
      languageService: this.languageService,
      scriptRegistry: this.#scriptRegistry,
      snapshots: this.#snapshots,
    });
  }
}
