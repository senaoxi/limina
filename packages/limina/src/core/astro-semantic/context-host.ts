import type {
  AstroLanguage,
  AstroMaterializedProject,
  AstroSemanticToolchain,
  AstroServiceScript,
  AstroSourceScript,
} from '#checkers';
import path from 'node:path';
import type ts from 'typescript';

export interface AstroMaterializedServiceScript {
  fileName: string;
  serviceScript: AstroServiceScript;
  sourceFile: ts.SourceFile;
  sourceScript: AstroSourceScript;
}

type AstroProjectHost = Parameters<
  AstroSemanticToolchain['volarTypeScript']['createLanguageServiceHost']
>[4];

export function getAstroLanguageId(fileName: string): string | undefined {
  const extension = path.extname(fileName).toLowerCase();
  const languageIds: Readonly<Record<string, string>> = {
    '.astro': 'astro',
    '.cts': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascriptreact',
    '.json': 'json',
    '.mjs': 'javascript',
    '.mts': 'typescript',
    '.svelte': 'svelte',
    '.ts': 'typescript',
    '.tsx': 'typescriptreact',
    '.vue': 'vue',
  };
  return languageIds[extension];
}

export function createAstroProjectHost(
  project: AstroMaterializedProject,
): AstroProjectHost {
  return {
    getCompilationSettings: () => project.snapshot.compilerOptions,
    getCurrentDirectory: () => path.dirname(project.seed.configPath),
    getProjectReferences: () => project.snapshot.projectReferences,
    getProjectVersion: () =>
      `${project.seed.analysisGeneration}:${project.seed.overlayGeneration}:${project.seed.id}`,
    getScriptFileNames: () => [...project.snapshot.fileNames],
  };
}

function requireTypeScriptHostResolver(
  host: ts.LanguageServiceHost,
): NonNullable<ts.LanguageServiceHost['resolveModuleNameLiterals']> {
  const resolver = host.resolveModuleNameLiterals;
  if (resolver !== undefined) return resolver;
  throw new Error(
    'The Astro semantic host does not expose resolveModuleNameLiterals.',
  );
}

function createSourceFile(options: {
  fileName: string;
  serviceScript: AstroServiceScript;
  toolchain: AstroSemanticToolchain;
}): ts.SourceFile {
  const snapshot = options.serviceScript.code.snapshot;
  return options.toolchain.tsModule.createSourceFile(
    options.fileName,
    snapshot.getText(0, snapshot.getLength()),
    options.toolchain.tsModule.ScriptTarget.Latest,
    true,
    options.serviceScript.scriptKind,
  );
}

function getPrimaryServiceScript(
  serviceScript: AstroServiceScript | undefined,
): AstroServiceScript[] {
  if (serviceScript === undefined) return [];
  return [serviceScript];
}

function getExtraServiceScripts(options: {
  fileName: string;
  generated: NonNullable<AstroSourceScript['generated']>;
}): readonly AstroServiceScript[] {
  const resolver =
    options.generated.languagePlugin.typescript?.getExtraServiceScripts;
  if (resolver === undefined) return [];
  return resolver(options.fileName, options.generated.root);
}

function getGeneratedServiceScripts(options: {
  fileName: string;
  sourceScript: AstroSourceScript;
}): readonly AstroServiceScript[] {
  const generated = options.sourceScript.generated;
  if (generated === undefined) return [];
  const provider = generated.languagePlugin.typescript;
  if (provider === undefined) return [];
  return [
    ...getPrimaryServiceScript(provider.getServiceScript(generated.root)),
    ...getExtraServiceScripts({ fileName: options.fileName, generated }),
  ];
}

export function materializeAstroServiceScripts(options: {
  fileName: string;
  sourceScript: AstroSourceScript;
  toolchain: AstroSemanticToolchain;
}): AstroMaterializedServiceScript[] {
  return getGeneratedServiceScripts(options).map((serviceScript) => {
    const fileName = serviceScript.fileName ?? options.fileName;
    return {
      fileName,
      serviceScript,
      sourceFile: createSourceFile({
        fileName,
        serviceScript,
        toolchain: options.toolchain,
      }),
      sourceScript: options.sourceScript,
    };
  });
}

function getResolvedEntries(options: {
  group: readonly ts.StringLiteralLike[];
  results: readonly ts.ResolvedModuleWithFailedLookupLocations[];
}): readonly (readonly [
  ts.StringLiteralLike,
  ts.ResolvedModuleWithFailedLookupLocations,
])[] {
  return options.group.flatMap((literal, index) => {
    const result = options.results[index];
    if (result === undefined) return [];
    return [[literal, result] as const];
  });
}

function getUnavailableReusedNames():
  | readonly ts.StringLiteralLike[]
  | undefined {
  return undefined;
}

export function resolveAstroModuleNameLiterals(options: {
  languageServiceHost: ts.LanguageServiceHost;
  literals: readonly ts.StringLiteralLike[];
}): ReadonlyMap<
  ts.StringLiteralLike,
  ts.ResolvedModuleWithFailedLookupLocations
> {
  const resolver = requireTypeScriptHostResolver(options.languageServiceHost);
  const groups = new Map<ts.SourceFile, ts.StringLiteralLike[]>();
  for (const literal of options.literals) {
    const sourceFile = literal.getSourceFile();
    const group = groups.get(sourceFile) ?? [];
    group.push(literal);
    groups.set(sourceFile, group);
  }
  const entries = [...groups].flatMap(([sourceFile, group]) => {
    const results = resolver(
      group,
      sourceFile.fileName,
      undefined,
      options.languageServiceHost.getCompilationSettings(),
      sourceFile,
      getUnavailableReusedNames(),
    );
    return getResolvedEntries({ group, results });
  });
  return new Map(entries);
}

export function createAstroLanguage(options: {
  scriptRegistry: Map<
    Parameters<AstroLanguage['scripts']['get']>[0],
    AstroSourceScript
  >;
  sync: (id: Parameters<AstroLanguage['scripts']['get']>[0]) => void;
  toolchain: AstroSemanticToolchain;
}): AstroLanguage {
  return options.toolchain.languageCore.createLanguage(
    [
      options.toolchain.astroCore.getAstroLanguagePlugin(),
      options.toolchain.vuePlugin.getLanguagePlugin(),
      options.toolchain.sveltePlugin.getLanguagePlugin(),
    ],
    options.scriptRegistry,
    options.sync,
  );
}
