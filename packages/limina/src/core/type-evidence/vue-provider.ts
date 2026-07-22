import type { ImportRecord } from '#core/import-analysis/runner';
import { normalizeAbsolutePath } from '#utils/path';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { createAmbientTypeEvidence } from './ambient-symbol';
import type {
  TypeEvidence,
  TypeEvidenceGenerationCache,
  TypeEvidenceProgramHandle,
  TypeEvidenceProvider,
} from './cache';
import type { TypeScriptTypeEvidenceProject } from './typescript-provider';

interface VueTypeEvidenceVersionTuple {
  languageCore: string;
  typeScript: string;
  volarTypeScript: string;
  vueTsc: string;
}

interface VolarVirtualCode {
  snapshot: ts.IScriptSnapshot;
}

interface VolarLanguagePlugin {
  typescript?: {
    getServiceScript(
      root: VolarVirtualCode,
    ): { code: VolarVirtualCode } | undefined;
  };
}

interface VolarSourceScript {
  generated?: {
    languagePlugin: VolarLanguagePlugin;
    root: VolarVirtualCode;
  };
}

interface VolarMapper {
  toGeneratedRange(
    start: number,
    end: number,
    fallbackToAnyMatch: boolean,
  ): Iterable<readonly [number, number, unknown, unknown]>;
}

interface VolarLanguage {
  maps: {
    get(code: VolarVirtualCode, source: VolarSourceScript): VolarMapper;
  };
  scripts: {
    delete(id: string): void;
    get(id: string): VolarSourceScript | undefined;
    set(
      id: string,
      snapshot: ts.IScriptSnapshot,
      languageId?: string,
    ): VolarSourceScript | undefined;
  };
}

interface VueLanguageRuntime {
  createLanguage(
    plugins: unknown[],
    scriptRegistry: Map<string, VolarSourceScript>,
    sync: (
      id: string,
      includeFsFiles: boolean,
      shouldRegister: boolean,
    ) => void,
  ): VolarLanguage;
  createParsedCommandLine(
    tsModule: typeof ts,
    host: typeof ts.sys,
    configFileName: string,
  ): {
    options: ts.CompilerOptions;
    projectReferences?: readonly ts.ProjectReference[];
    vueOptions: unknown;
  };
  createVueLanguagePlugin(
    tsModule: typeof ts,
    compilerOptions: ts.CompilerOptions,
    vueOptions: unknown,
    asFileName: (scriptId: string) => string,
  ): unknown;
}

interface VolarTypeScriptRuntime {
  createLanguageServiceHost(
    tsModule: typeof ts,
    sys: typeof ts.sys,
    language: VolarLanguage,
    asScriptId: (fileName: string) => string,
    projectHost: {
      getCompilationSettings(): ts.CompilerOptions;
      getCurrentDirectory(): string;
      getProjectReferences(): readonly ts.ProjectReference[] | undefined;
      getProjectVersion(): string;
      getScriptFileNames(): string[];
    },
  ): {
    languageServiceHost: ts.LanguageServiceHost;
  };
}

export type VueTypeEvidenceCapability =
  | {
      kind: 'supported';
      languageCore: VueLanguageRuntime;
      tsModule: typeof ts;
      versionTuple: VueTypeEvidenceVersionTuple;
      volarTypeScript: VolarTypeScriptRuntime;
    }
  | {
      kind: 'unsupported';
      reason: string;
      versionTuple?: VueTypeEvidenceVersionTuple;
    };

interface VueProgramHandle extends TypeEvidenceProgramHandle {
  language: VolarLanguage;
  languageService: ts.LanguageService;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readPackageVersion(
  requireFromVueTsc: NodeRequire,
  name: string,
): string {
  const manifest = requireFromVueTsc(`${name}/package.json`) as unknown;

  if (!isRecord(manifest) || typeof manifest.version !== 'string') {
    throw new TypeError(`Package ${name} does not expose a string version.`);
  }

  return manifest.version;
}

function hasVersionPrefix(version: string, prefix: string): boolean {
  return version === prefix || version.startsWith(`${prefix}.`);
}

export function isSupportedVueTypeEvidenceVersionTuple(
  tuple: VueTypeEvidenceVersionTuple,
): boolean {
  return (
    hasVersionPrefix(tuple.vueTsc, '3.2') &&
    hasVersionPrefix(tuple.languageCore, '3.2') &&
    hasVersionPrefix(tuple.volarTypeScript, '2.4') &&
    (hasVersionPrefix(tuple.typeScript, '5.9') ||
      hasVersionPrefix(tuple.typeScript, '6.0'))
  );
}

function assertRuntimeFunctions(
  languageCoreValue: unknown,
  volarTypeScriptValue: unknown,
): {
  languageCore: VueLanguageRuntime;
  volarTypeScript: VolarTypeScriptRuntime;
} {
  if (
    !isRecord(languageCoreValue) ||
    typeof languageCoreValue.createParsedCommandLine !== 'function' ||
    typeof languageCoreValue.createVueLanguagePlugin !== 'function' ||
    typeof languageCoreValue.createLanguage !== 'function'
  ) {
    throw new TypeError(
      '@vue/language-core does not expose the approved Language Service adapter API shape.',
    );
  }

  if (
    !isRecord(volarTypeScriptValue) ||
    typeof volarTypeScriptValue.createLanguageServiceHost !== 'function'
  ) {
    throw new TypeError(
      '@volar/typescript does not expose createLanguageServiceHost.',
    );
  }

  return {
    languageCore: languageCoreValue as unknown as VueLanguageRuntime,
    volarTypeScript: volarTypeScriptValue as unknown as VolarTypeScriptRuntime,
  };
}

export function resolveVueTypeEvidenceCapability(
  configPath: string,
): VueTypeEvidenceCapability {
  try {
    const requireFromProject = createRequire(configPath);
    const vueTscManifestPath = requireFromProject.resolve(
      'vue-tsc/package.json',
    );
    const requireFromVueTsc = createRequire(vueTscManifestPath);
    const versionTuple = {
      languageCore: readPackageVersion(requireFromVueTsc, '@vue/language-core'),
      typeScript: readPackageVersion(requireFromVueTsc, 'typescript'),
      volarTypeScript: readPackageVersion(
        requireFromVueTsc,
        '@volar/typescript',
      ),
      vueTsc: readPackageVersion(requireFromVueTsc, 'vue-tsc'),
    };

    if (!isSupportedVueTypeEvidenceVersionTuple(versionTuple)) {
      return {
        kind: 'unsupported',
        reason: `Unsupported Vue checker tuple: vue-tsc ${versionTuple.vueTsc}, @vue/language-core ${versionTuple.languageCore}, @volar/typescript ${versionTuple.volarTypeScript}, TypeScript ${versionTuple.typeScript}.`,
        versionTuple,
      };
    }

    const runtime = assertRuntimeFunctions(
      requireFromVueTsc('@vue/language-core') as unknown,
      requireFromVueTsc('@volar/typescript') as unknown,
    );
    const tsModule = requireFromVueTsc('typescript') as typeof ts;

    if (
      typeof tsModule.createLanguageService !== 'function' ||
      typeof tsModule.ScriptSnapshot?.fromString !== 'function'
    ) {
      return {
        kind: 'unsupported',
        reason:
          'The resolved TypeScript package does not expose the approved Language Service API shape.',
        versionTuple,
      };
    }

    return {
      kind: 'supported',
      ...runtime,
      tsModule,
      versionTuple,
    };
  } catch (error) {
    return {
      kind: 'unsupported',
      reason: `Unable to initialize the Vue type-evidence adapter: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function createVueProgramHandle(options: {
  capability: Extract<VueTypeEvidenceCapability, { kind: 'supported' }>;
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
  const snapshots = new Map<
    string,
    { snapshot: ts.IScriptSnapshot; text: string }
  >();
  let language: VolarLanguage;
  const getLanguageId = (fileName: string): string | undefined => {
    if (/\.(?:cts|mts|ts)$/iu.test(fileName)) {
      return 'typescript';
    }

    if (/\.tsx$/iu.test(fileName)) {
      return 'typescriptreact';
    }

    if (/\.(?:cjs|js|mjs)$/iu.test(fileName)) {
      return 'javascript';
    }

    if (/\.jsx$/iu.test(fileName)) {
      return 'javascriptreact';
    }

    if (/\.json$/iu.test(fileName)) {
      return 'json';
    }

    return undefined;
  };
  const sync = (id: string): void => {
    const text = tsModule.sys.readFile(id);
    const cached = snapshots.get(id);

    if (text === undefined) {
      if (cached) {
        snapshots.delete(id);
        language.scripts.delete(id);
      }
      return;
    }

    if (cached?.text === text) {
      return;
    }

    const snapshot = tsModule.ScriptSnapshot.fromString(text);

    snapshots.set(id, { snapshot, text });
    language.scripts.set(id, snapshot, getLanguageId(id));
  };

  language = languageCore.createLanguage([plugin], scriptRegistry, sync);
  const { languageServiceHost } = volarTypeScript.createLanguageServiceHost(
    tsModule,
    tsModule.sys,
    language,
    (fileName) => fileName,
    {
      getCompilationSettings: () => parsed.options,
      getCurrentDirectory: () => path.dirname(options.project.configPath),
      getProjectReferences: () => parsed.projectReferences,
      getProjectVersion: () => '0',
      getScriptFileNames: () => [...options.project.fileNames],
    },
  );
  const languageService = tsModule.createLanguageService(languageServiceHost);
  const program = languageService.getProgram();

  if (!program) {
    languageService.dispose();
    throw new Error('Vue Language Service did not create a Program.');
  }

  return {
    dispose(): void {
      languageService.dispose();
      for (const id of snapshots.keys()) {
        language.scripts.delete(id);
      }
      snapshots.clear();
      scriptRegistry.clear();
    },
    language,
    languageService,
    program,
  };
}

function collectNativeModuleLiteral(options: {
  handle: VueProgramHandle;
  importRecord: ImportRecord;
}): ts.StringLiteralLike[] | null {
  const sourceFile = options.handle.program.getSourceFile(
    normalizeAbsolutePath(options.importRecord.filePath),
  );

  if (!sourceFile) {
    return null;
  }

  let matched: ts.StringLiteralLike | null = null;
  const visit = (node: ts.Node): void => {
    if (matched) {
      return;
    }

    if (
      ts.isStringLiteralLike(node) &&
      node.text === options.importRecord.specifier &&
      node.getStart(sourceFile) === options.importRecord.locator.sourceStart &&
      node.getEnd() === options.importRecord.locator.sourceEnd
    ) {
      matched = node;
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return matched ? [matched] : null;
}

function collectMappedModuleLiterals(options: {
  handle: VueProgramHandle;
  importRecord: ImportRecord;
}): ts.StringLiteralLike[] | null {
  const sourceScript = options.handle.language.scripts.get(
    normalizeAbsolutePath(options.importRecord.filePath),
  );
  const generated = sourceScript?.generated;
  const serviceScript = generated?.languagePlugin.typescript?.getServiceScript(
    generated.root,
  );

  if (!sourceScript || !serviceScript) {
    return null;
  }

  const mapper = options.handle.language.maps.get(
    serviceScript.code,
    sourceScript,
  );
  const generatedRanges = [
    ...mapper.toGeneratedRange(
      options.importRecord.locator.sourceStart,
      options.importRecord.locator.sourceEnd,
      true,
    ),
  ];
  const sourceFile = options.handle.program.getSourceFile(
    normalizeAbsolutePath(options.importRecord.filePath),
  );

  if (!sourceFile || generatedRanges.length === 0) {
    return null;
  }

  const rangeIdentities = new Set(
    generatedRanges.map(([start, end]) => JSON.stringify([start, end])),
  );
  const literals: ts.StringLiteralLike[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteralLike(node) &&
      node.text === options.importRecord.specifier &&
      rangeIdentities.has(
        JSON.stringify([node.getStart(sourceFile), node.getEnd()]),
      )
    ) {
      literals.push(node);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return literals;
}

function canonicalAmbientIdentity(evidence: TypeEvidence): string | null {
  return evidence.kind === 'ambient'
    ? JSON.stringify([
        evidence.modulePattern,
        [...evidence.declarationFilePaths].sort((left, right) =>
          left.localeCompare(right),
        ),
      ])
    : null;
}

export function createVueTypeEvidenceProvider(options: {
  cache: TypeEvidenceGenerationCache;
  capability: Extract<VueTypeEvidenceCapability, { kind: 'supported' }>;
  checkerName: string;
  programKey: string;
  project: TypeScriptTypeEvidenceProject;
}): TypeEvidenceProvider {
  let disposed = false;
  let unsupportedReason: string | null = null;

  return {
    dispose(): void {
      disposed = true;
    },
    query({ importRecord }): TypeEvidence {
      if (disposed) {
        throw new Error('Vue type-evidence provider was disposed.');
      }

      if (unsupportedReason) {
        return {
          checker: options.checkerName,
          kind: 'unsupported-checker',
          reason: unsupportedReason,
        };
      }

      let handle: VueProgramHandle;

      try {
        handle = options.cache.getOrCreateProgram(
          options.programKey,
          () => createVueProgramHandle(options),
          'vue',
        ) as VueProgramHandle;
      } catch (error) {
        unsupportedReason = `Vue Language Service initialization failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
        return {
          checker: options.checkerName,
          kind: 'unsupported-checker',
          reason: unsupportedReason,
        };
      }

      const literals = importRecord.filePath.toLowerCase().endsWith('.vue')
        ? collectMappedModuleLiterals({ handle, importRecord })
        : collectNativeModuleLiteral({ handle, importRecord });

      if (!literals || literals.length === 0) {
        return {
          checker: options.checkerName,
          kind: 'unsupported-checker',
          reason:
            'Vue source-map locator did not resolve to a unique virtual module literal set.',
        };
      }

      const evidence = literals.map((literal) => {
        const symbol = handle.program
          .getTypeChecker()
          .getSymbolAtLocation(literal);

        return symbol
          ? options.cache.getOrCreateAmbientSymbolEvidence(symbol, () =>
              createAmbientTypeEvidence(symbol),
            )
          : ({ kind: 'missing' } satisfies TypeEvidence);
      });

      if (evidence.every((item) => item.kind === 'missing')) {
        return { kind: 'missing' };
      }

      const identities = evidence.map(canonicalAmbientIdentity);
      const firstIdentity = identities[0];

      if (
        firstIdentity &&
        identities.every((identity) => identity === firstIdentity)
      ) {
        return evidence[0]!;
      }

      return {
        checker: options.checkerName,
        kind: 'unsupported-checker',
        reason:
          'Vue source-map candidates did not agree on one canonical ambient module symbol.',
      };
    },
  };
}
