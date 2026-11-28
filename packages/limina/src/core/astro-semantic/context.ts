import type {
  AstroLanguage,
  AstroMaterializedProject,
  AstroSemanticProject,
  AstroSemanticToolchain,
  AstroServiceScript,
  AstroSourceScript,
  AstroUri,
} from '#checkers';
import {
  createAstroMaterializedIdentity,
  materializeAstroSemanticProject,
  resolveAstroSemanticToolchain,
} from '#checkers';
import { observeAnalysisRead, readAnalysisInput } from '#utils/analysis-input';
import { normalizeAbsolutePath } from '#utils/path';
import type { GovernanceRootBase } from '#utils/workspace-root';
import type ts from 'typescript';
import {
  currentProfile,
  type ProfileScope,
} from '../../application/analysis/observability';
import {
  observeWork,
  priorProfileContextScope,
  profileContextScope,
} from '../analysis-profile';
import { createBoundedLanguageServiceHost } from '../framework-semantic/bounded-host';
import { FrameworkCompilerRequests } from '../framework-semantic/compiler-requests';
import type { FrameworkRuntimeModuleResolver } from '../framework-semantic/runtime-dependencies';
import { createVolarRuntimeResolution } from '../framework-semantic/volar-runtime-resolution';
import type { ImportAnalysisMetricsRecorder } from '../import-analysis/types';
import { observedCompilerSystem } from '../typescript-semantic/observed-resolution-host';
import { createWorkspaceSourceBoundary } from '../typescript-semantic/workspace-source-boundary';
import type {
  AstroMaterializedServiceScript,
  AstroServiceScriptDescriptor,
} from './context-host';
import {
  canReuseAstroContext,
  createAstroLanguage,
  createAstroProjectHost,
  getAstroLanguageId,
  getAstroServiceScriptDescriptors,
  materializeAstroServiceScripts,
  recordAstroMetric,
  resolveAstroModuleNameLiterals,
} from './context-host';

export type {
  AstroMaterializedServiceScript,
  AstroServiceScriptDescriptor,
} from './context-host';

interface SnapshotEntry {
  snapshot: ts.IScriptSnapshot;
  text: string;
}

export type AstroSemanticToolchainResolver = (
  packageRootDirectory: string,
) => AstroSemanticToolchain;

export class AstroSemanticContext {
  readonly #scriptRegistry = new Map<AstroUri, AstroSourceScript>();
  readonly #snapshots = new Map<string, SnapshotEntry>();
  readonly #uriByFileName = new Map<string, AstroUri>();
  #languageService: ts.LanguageService | undefined;
  readonly #boundedHost: ReturnType<typeof createBoundedLanguageServiceHost>;
  readonly #getExtraServiceScript:
    | ((fileName: string) => AstroServiceScript | undefined)
    | undefined;
  #program: ts.Program | undefined;
  #disposed = false;
  readonly identity: string;
  readonly compilerRequests: FrameworkCompilerRequests;
  readonly resolveRuntimeModule: FrameworkRuntimeModuleResolver;
  readonly language: AstroLanguage;
  readonly languageServiceHost: ts.LanguageServiceHost;
  readonly project: AstroMaterializedProject;
  readonly toolchain: AstroSemanticToolchain;
  constructor(options: {
    project: AstroMaterializedProject;
    toolchain: AstroSemanticToolchain;
  }) {
    this.project = options.project;
    this.compilerRequests = new FrameworkCompilerRequests(
      options.toolchain.tsModule,
      options.project.seed.configPath,
    );
    this.toolchain = options.toolchain;
    this.identity = createAstroMaterializedIdentity(options);
    this.language = createAstroLanguage({
      scriptRegistry: this.#scriptRegistry,
      sync: (id) => this.#syncScript(id),
      toolchain: options.toolchain,
    });
    const runtime = createVolarRuntimeResolution(options.toolchain.tsModule);
    const { getExtraServiceScript, languageServiceHost: host } =
      options.toolchain.volarTypeScript.createLanguageServiceHost(
        runtime.compiler,
        observedCompilerSystem(
          options.toolchain.tsModule,
          options.project.seed.configPath,
        ),
        this.language,
        (fileName) => this.asUri(fileName),
        createAstroProjectHost(options.project),
      );
    this.#getExtraServiceScript = getExtraServiceScript;
    options.toolchain.astroCore.addAstroTypes(
      options.toolchain.astroInstall,
      options.toolchain.tsModule,
      host,
    );
    this.languageServiceHost = host;
    const resolveRuntime = host.resolveModuleNameLiterals?.bind(host);
    this.resolveRuntimeModule = (source, literal, occurrence) =>
      runtime.resolve(
        resolveRuntime,
        this.program,
        source,
        literal,
        occurrence,
      );
    this.#boundedHost = createBoundedLanguageServiceHost({
      observeModule: (input) => this.compilerRequests.observe(input),
      observeType: (input) => this.compilerRequests.observeType(input),
      observeOptions: (input) => this.compilerRequests.observeOptions(input),
      host,
      tsModule: options.toolchain.tsModule,
      project: {
        configPath: options.project.seed.configPath,
        fileNames: host.getScriptFileNames(),
        options: host.getCompilationSettings(),
        projectReferences: host.getProjectReferences?.(),
        workspaceSourceBoundary: createWorkspaceSourceBoundary([]),
      },
    });
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
        this.#boundedHost.host,
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
    // A context owns one input view; missing/throwing reads remain retryable.
    const text =
      this.#snapshots.get(fileName)?.text ??
      readAnalysisInput(
        fileName,
        () => this.toolchain.tsModule.sys.readFile(fileName),
        'typescript-content',
      );
    if (text === undefined) {
      this.#deleteScript(id, fileName);
      return;
    }
    if (/\.(?:svelte|vue)$/u.test(fileName)) {
      // Astro resolves the editor integration relative to this physical component,
      // outside the Compiler host. Its package lookups have no cross-process proof.
      observeAnalysisRead({
        key: JSON.stringify(['astro-editor-integration', fileName]),
        path: fileName,
        value: true,
        read: () => true,
      });
    }
    if (this.#hasCurrentSnapshot(fileName, text)) return;
    const snapshot = this.toolchain.tsModule.ScriptSnapshot.fromString(text);
    this.#snapshots.set(fileName, { snapshot, text });
    this.language.scripts.set(id, snapshot, getAstroLanguageId(fileName));
  }
  #createProgram(): ts.Program {
    const observer = currentProfile();
    const scope = this.profileScope(observer);
    let pass = 0;
    do {
      this.#boundedHost.begin();
      const program =
        observer === undefined
          ? this.#requireProgram()
          : observeWork(
              observer,
              'astro-program-create',
              () => this.#requireProgram(),
              scope,
              ++pass,
              'computed',
            );
      if (!this.#boundedHost.needsRebuild()) return program;
      this.#disposeLanguageService();
    } while (true);
  }
  #requireProgram(): ts.Program {
    const program = this.#getLanguageService().getProgram();
    if (program === undefined)
      throw new Error('Astro Language Service did not create a Program.');
    return program;
  }
  profileScope(
    observer: ReturnType<typeof currentProfile>,
  ): ProfileScope | undefined {
    if (observer === undefined) return undefined;
    return profileContextScope(observer, {
      instance: this,
      configPath: this.project.seed.configPath,
      checker: 'astro',
      provider: 'astro',
      role: 'source',
    });
  }
  get program(): ts.Program {
    this.assertActive();
    this.#program ??= this.#createProgram();
    return this.#program;
  }
  asUri(fileName: string): AstroUri {
    const normalized = normalizeAbsolutePath(fileName);
    const cached = this.#uriByFileName.get(normalized);
    if (cached !== undefined) return cached;
    const uri = this.toolchain.vscodeUri.URI.file(normalized);
    this.#uriByFileName.set(normalized, uri);
    return uri;
  }
  getServiceScriptDescriptors(
    fileName: string,
  ): AstroServiceScriptDescriptor[] {
    this.assertActive();
    const normalized = normalizeAbsolutePath(fileName);
    const sourceScript = this.language.scripts.get(
      this.asUri(normalized),
      true,
      true,
    );
    if (sourceScript === undefined) return [];
    return getAstroServiceScriptDescriptors({
      fileName: normalized,
      sourceScript,
    });
  }
  getServiceScripts(fileName: string): AstroMaterializedServiceScript[] {
    return materializeAstroServiceScripts(
      this.getServiceScriptDescriptors(fileName),
      this.toolchain,
    );
  }
  isUnregisteredExtraServiceScript(fileName: string): boolean {
    return (
      this.#getExtraServiceScript !== undefined &&
      this.#getExtraServiceScript(fileName) === undefined
    );
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
    const observer = currentProfile();
    observeWork(
      observer,
      'astro-context-dispose',
      () => {
        this.compilerRequests.dispose();
        this.#disposeLanguageService();
        this.#program = undefined;
        this.#deleteRegisteredScripts();
        this.#snapshots.clear();
        this.#scriptRegistry.clear();
        this.#uriByFileName.clear();
      },
      priorProfileContextScope(observer, this),
    );
  }
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
      governanceRoot?: GovernanceRootBase;
    } = {},
  ) {
    this.#metrics = options.metrics;
    this.#resolveToolchain =
      options.resolveToolchain ??
      ((directory) =>
        resolveAstroSemanticToolchain(
          directory,
          directory === options.governanceRoot?.rootDir
            ? options.governanceRoot.manifest
            : undefined,
        ));
  }
  #disposeActive(): void {
    if (this.#active === undefined) return;
    this.#active.dispose();
    this.#active = undefined;
    recordAstroMetric({
      metrics: this.#metrics,
      name: 'astro-context-dispose',
    });
  }
  #getToolchain(packageRootDirectory: string): AstroSemanticToolchain {
    const root = normalizeAbsolutePath(packageRootDirectory);
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
  acquire(project: AstroSemanticProject): AstroSemanticContext {
    this.#assertActive();
    const toolchain = this.#getToolchain(project.seed.packageRootDir);
    const reusable = { active: this.#active, project, toolchain };
    if (canReuseAstroContext(reusable)) {
      reusable.active.assertActive();
      recordAstroMetric({
        metrics: this.#metrics,
        name: 'astro-context-reuse',
      });
      return reusable.active;
    }
    const observer = currentProfile();
    const projectId = observer?.project(project.seed.configPath);
    this.#active = observeWork(
      observer,
      'astro-context-create',
      () => {
        const materializedProject = materializeAstroSemanticProject(
          project,
          toolchain,
        );
        this.#disposeActive();
        return new AstroSemanticContext({
          project: materializedProject,
          toolchain,
        });
      },
      projectId === undefined ? undefined : ['project', projectId],
    );
    this.#active.profileScope(observer);
    recordAstroMetric({
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
}
