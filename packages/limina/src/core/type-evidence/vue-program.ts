import { normalizeAbsolutePath } from '#utils/path';
import path from 'node:path';
import type ts from 'typescript';
import type { TypeScriptTypeEvidenceProject } from './typescript-provider';
import type {
  SupportedVueTypeEvidenceCapability,
  VolarLanguage,
  VolarSourceScript,
  VueProgramHandle,
} from './vue-provider-types';

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

function removeMissingScript(store: VueScriptStore, id: string): void {
  if (!store.snapshots.has(id)) {
    return;
  }
  store.snapshots.delete(id);
  store.language?.scripts.delete(id);
}

function isCurrentSnapshot(options: {
  id: string;
  store: VueScriptStore;
  text: string;
}): boolean {
  const current = options.store.snapshots.get(options.id);
  return current !== undefined && current.text === options.text;
}

function setLanguageScript(options: {
  id: string;
  snapshot: ts.IScriptSnapshot;
  store: VueScriptStore;
}): void {
  if (options.store.language === undefined) {
    return;
  }
  options.store.language.scripts.set(
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
  if (isCurrentSnapshot(options)) {
    return;
  }
  const snapshot = options.tsModule.ScriptSnapshot.fromString(options.text);
  options.store.snapshots.set(options.id, { snapshot, text: options.text });
  setLanguageScript({ id: options.id, snapshot, store: options.store });
}

function syncScript(options: {
  id: string;
  store: VueScriptStore;
  tsModule: typeof ts;
}): void {
  const text = options.tsModule.sys.readFile(options.id);
  if (text === undefined) {
    removeMissingScript(options.store, options.id);
    return;
  }
  updateScript({ ...options, text });
}

function createProjectHost(options: {
  parsed: ReturnType<
    SupportedVueTypeEvidenceCapability['languageCore']['createParsedCommandLine']
  >;
  project: TypeScriptTypeEvidenceProject;
}): {
  getCompilationSettings(): ts.CompilerOptions;
  getCurrentDirectory(): string;
  getProjectReferences(): readonly ts.ProjectReference[] | undefined;
  getProjectVersion(): string;
  getScriptFileNames(): string[];
} {
  return {
    getCompilationSettings: () => options.parsed.options,
    getCurrentDirectory: () => path.dirname(options.project.configPath),
    getProjectReferences: () => options.parsed.projectReferences,
    getProjectVersion: () => '0',
    getScriptFileNames: () => [...options.project.fileNames],
  };
}

function disposeProgram(options: {
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

export function createVueProgramHandle(options: {
  capability: SupportedVueTypeEvidenceCapability;
  project: TypeScriptTypeEvidenceProject;
}): VueProgramHandle {
  const { languageCore, tsModule, volarTypeScript } = options.capability;
  const parsed = languageCore.createParsedCommandLine(
    tsModule,
    tsModule.sys,
    normalizeAbsolutePath(options.project.configPath),
  );
  const plugin = languageCore.createVueLanguagePlugin(
    tsModule,
    parsed.options,
    parsed.vueOptions,
    (scriptId) => scriptId,
  );
  const scriptRegistry = new Map<string, VolarSourceScript>();
  const store: VueScriptStore = { language: undefined, snapshots: new Map() };
  const language = languageCore.createLanguage([plugin], scriptRegistry, (id) =>
    syncScript({ id, store, tsModule }),
  );
  store.language = language;
  const { languageServiceHost } = volarTypeScript.createLanguageServiceHost(
    tsModule,
    tsModule.sys,
    language,
    (fileName) => fileName,
    createProjectHost({ parsed, project: options.project }),
  );
  const languageService = tsModule.createLanguageService(languageServiceHost);
  const program = languageService.getProgram();
  if (program === undefined) {
    languageService.dispose();
    throw new Error('Vue Language Service did not create a Program.');
  }

  return {
    dispose: () =>
      disposeProgram({
        language,
        languageService,
        scriptRegistry,
        snapshots: store.snapshots,
      }),
    language,
    languageService,
    program,
  };
}
