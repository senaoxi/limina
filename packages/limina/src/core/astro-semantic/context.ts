import type {
  AstroLanguage,
  AstroMaterializedProject,
  AstroSemanticProject,
  AstroSemanticToolchain,
  AstroSourceScript,
  AstroUri,
} from '#checkers';
import {
  createAstroMaterializedIdentity,
  materializeAstroSemanticProject,
  resolveAstroSemanticToolchain,
} from '#checkers';
import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import type { ImportAnalysisMetricsRecorder } from '../import-analysis/types';
import type { AstroMaterializedServiceScript } from './context-host';
import {
  createAstroLanguage,
  createAstroProjectHost,
  getAstroLanguageId,
  materializeAstroServiceScripts,
  resolveAstroModuleNameLiterals,
} from './context-host';

export type { AstroMaterializedServiceScript } from './context-host';

interface SnapshotEntry {
  snapshot: ts.IScriptSnapshot;
  text: string;
}

export type AstroSemanticToolchainResolver = (
  packageRootDir: string,
) => AstroSemanticToolchain;

export class AstroSemanticContext {
  readonly identity: string;
  readonly language: AstroLanguage;
  readonly languageServiceHost: ts.LanguageServiceHost;
  readonly project: AstroMaterializedProject;
  readonly toolchain: AstroSemanticToolchain;
  readonly #scriptRegistry = new Map<AstroUri, AstroSourceScript>();
  readonly #snapshots = new Map<string, SnapshotEntry>();
  readonly #uriByFileName = new Map<string, AstroUri>();
  #languageService: ts.LanguageService | undefined;
  #program: ts.Program | undefined;
  #disposed = false;

  constructor(options: {
    project: AstroMaterializedProject;
    toolchain: AstroSemanticToolchain;
  }) {
    this.project = options.project;
    this.toolchain = options.toolchain;
    this.identity = createAstroMaterializedIdentity(options);
    this.language = createAstroLanguage({
      scriptRegistry: this.#scriptRegistry,
      sync: (id) => this.#syncScript(id),
      toolchain: options.toolchain,
    });
    const host = options.toolchain.volarTypeScript.createLanguageServiceHost(
      options.toolchain.tsModule,
      options.toolchain.tsModule.sys,
      this.language,
      (fileName) => this.asUri(fileName),
      createAstroProjectHost(options.project),
    ).languageServiceHost;
    options.toolchain.astroCore.addAstroTypes(
      options.toolchain.astroInstall,
      options.toolchain.tsModule,
      host,
    );
    this.languageServiceHost = host;
  }

  get program(): ts.Program {
    this.assertActive();
    if (this.#program !== undefined) return this.#program;
    const program = this.#getLanguageService().getProgram();
    if (program === undefined) {
      throw new Error('Astro Language Service did not create a Program.');
    }
    this.#program = program;
    return program;
  }

  asUri(fileName: string): AstroUri {
    const normalized = normalizeAbsolutePath(fileName);
    const cached = this.#uriByFileName.get(normalized);
    if (cached !== undefined) return cached;
    const uri = this.toolchain.vscodeUri.URI.file(normalized);
    this.#uriByFileName.set(normalized, uri);
    return uri;
  }

  getServiceScripts(fileName: string): AstroMaterializedServiceScript[] {
    this.assertActive();
    const normalized = normalizeAbsolutePath(fileName);
    const sourceScript = this.language.scripts.get(
      this.asUri(normalized),
      true,
      true,
    );
    if (sourceScript === undefined) return [];
    return materializeAstroServiceScripts({
      fileName: normalized,
      sourceScript,
      toolchain: this.toolchain,
    });
  }

  resolveModuleNameLiterals(
    literals: readonly ts.StringLiteralLike[],
  ): ReadonlyMap<
    ts.StringLiteralLike,
    ts.ResolvedModuleWithFailedLookupLocations
  > {
    this.assertActive();
    return resolveAstroModuleNameLiterals({
      languageServiceHost: this.languageServiceHost,
      literals,
    });
  }

  assertActive(): void {
    if (this.#disposed) {
      throw new Error('Astro semantic context was disposed.');
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#disposeLanguageService();
    this.#program = undefined;
    this.#deleteRegisteredScripts();
    this.#snapshots.clear();
    this.#scriptRegistry.clear();
    this.#uriByFileName.clear();
  }

  #deleteRegisteredScripts(): void {
    for (const uri of this.#uriByFileName.values()) {
      this.language.scripts.delete(uri);
    }
  }

  #disposeLanguageService(): void {
    this.#languageService?.dispose();
    this.#languageService = undefined;
  }

  #getLanguageService(): ts.LanguageService {
    if (this.#languageService === undefined) {
      this.#languageService = this.toolchain.tsModule.createLanguageService(
        this.languageServiceHost,
      );
    }
    return this.#languageService;
  }

  #deleteScript(id: AstroUri, fileName: string): void {
    if (this.#snapshots.delete(fileName)) this.language.scripts.delete(id);
  }

  #hasCurrentSnapshot(fileName: string, text: string): boolean {
    return this.#snapshots.get(fileName)?.text === text;
  }

  #syncScript(id: AstroUri): void {
    const fileName = normalizeAbsolutePath(id.fsPath);
    const text = this.toolchain.tsModule.sys.readFile(fileName);
    if (text === undefined) {
      this.#deleteScript(id, fileName);
      return;
    }
    if (this.#hasCurrentSnapshot(fileName, text)) return;
    const snapshot = this.toolchain.tsModule.ScriptSnapshot.fromString(text);
    this.#snapshots.set(fileName, { snapshot, text });
    this.language.scripts.set(id, snapshot, getAstroLanguageId(fileName));
  }
}

function recordMetric(options: {
  metrics: ImportAnalysisMetricsRecorder | undefined;
  name:
    | 'astro-context-dispose'
    | 'astro-context-materialize'
    | 'astro-context-reuse';
}): void {
  options.metrics?.record({ name: options.name, provider: 'astro-semantic' });
}

function canReuseContext(options: {
  active: AstroSemanticContext | undefined;
  project: AstroSemanticProject;
  toolchain: AstroSemanticToolchain;
}): options is {
  active: AstroSemanticContext;
  project: AstroSemanticProject;
  toolchain: AstroSemanticToolchain;
} {
  if (options.active === undefined) return false;
  return (
    options.active.project.seed.id === options.project.seed.id &&
    options.active.toolchain === options.toolchain
  );
}

export class AstroSemanticContextManager {
  readonly #metrics: ImportAnalysisMetricsRecorder | undefined;
  readonly #resolveToolchain: AstroSemanticToolchainResolver;
  readonly #toolchainByRoot = new Map<string, AstroSemanticToolchain>();
  #active: AstroSemanticContext | undefined;
  #disposed = false;

  constructor(
    options: {
      metrics?: ImportAnalysisMetricsRecorder;
      resolveToolchain?: AstroSemanticToolchainResolver;
    } = {},
  ) {
    this.#metrics = options.metrics;
    this.#resolveToolchain =
      options.resolveToolchain ?? resolveAstroSemanticToolchain;
  }

  acquire(project: AstroSemanticProject): AstroSemanticContext {
    this.#assertActive();
    const toolchain = this.#getToolchain(project.seed.packageRootDir);
    const reusable = { active: this.#active, project, toolchain };
    if (canReuseContext(reusable)) {
      reusable.active.assertActive();
      recordMetric({ metrics: this.#metrics, name: 'astro-context-reuse' });
      return reusable.active;
    }
    const materializedProject = materializeAstroSemanticProject(project);
    this.#disposeActive();
    this.#active = new AstroSemanticContext({
      project: materializedProject,
      toolchain,
    });
    recordMetric({
      metrics: this.#metrics,
      name: 'astro-context-materialize',
    });
    return this.#active;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#disposeActive();
    this.#toolchainByRoot.clear();
  }

  #disposeActive(): void {
    if (this.#active === undefined) return;
    this.#active.dispose();
    this.#active = undefined;
    recordMetric({ metrics: this.#metrics, name: 'astro-context-dispose' });
  }

  #getToolchain(packageRootDir: string): AstroSemanticToolchain {
    const root = normalizeAbsolutePath(packageRootDir);
    const cached = this.#toolchainByRoot.get(root);
    if (cached !== undefined) return cached;
    const toolchain = this.#resolveToolchain(root);
    this.#toolchainByRoot.set(root, toolchain);
    return toolchain;
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error('Astro semantic context manager was disposed.');
    }
  }
}
