import { readAnalysisFileDigest } from '#utils/analysis-input';
import { AnalysisInputDriftError } from '#utils/analysis-input-drift';
import { compareCodeUnits } from '#utils/collections';
import { compilerPathPolicy } from '#utils/compiler-path-policy';
import { normalizeAbsolutePath } from '#utils/path';
import { parseLiveConfig } from '#utils/resolved-config-cache';
import {
  readRawSourceConfig,
  withSourceConfigTextScope,
} from '#utils/source-config-text';
import { typeScriptBomText } from '#utils/typescript-bom';
import { isPlainRecord } from '#utils/values';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'pathe';
import type ts from 'typescript';
import { normalizeExtensions } from './extensions';
import {
  canReuseConfigProjection,
  createProjectParseHost,
  observeConfigParse,
  parseWithObservedConfigInputs,
} from './project-base';
import type { ResolvedConfigProjection } from './resolved-config';
import type {
  CheckerProjectConfigParseOptions,
  ConfigRootSelector,
} from './types';
import { isVueCacheTuple } from './vue-semantic-compatibility';
import {
  createVueConfigReadRecorder,
  createVueOverlayFingerprint,
  createVueOverlaySystem,
  mergeVueVirtualFiles,
  normalizeVueVirtualFiles,
  type VueConfigReadRecorder,
} from './vue-semantic-overlay';
import {
  createVueExtraFileExtensions,
  createVueSourceProfiles,
  getNativeTypeScriptExtensions,
} from './vue-semantic-profiles';
import { resolveVueSemanticToolchain } from './vue-semantic-toolchain';
import type {
  VueConfigClosureEntry,
  VueProjectSemanticIdentity,
  VueSemanticToolchain,
  VueSourceProfile,
} from './vue-semantic-types';

export { createVueOverlaySystem } from './vue-semantic-overlay';
export {
  isSupportedVueSemanticVersionTuple,
  resolveVueSemanticAdapter,
  resolveVueSemanticToolchain,
} from './vue-semantic-toolchain';

interface SemanticProjectParseResult {
  rootSelectors: readonly ConfigRootSelector[];
  diagnostics: readonly ts.Diagnostic[];
  extensions: readonly string[];
  identity: VueProjectSemanticIdentity;
  parsed: ts.ParsedCommandLine;
}

type SemanticProjectParseOptions = CheckerProjectConfigParseOptions & {
  wrapSystem?: (
    system: ts.System,
    toolchain: VueSemanticToolchain,
  ) => ts.System;
};

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function getSortedConfigClosure(
  recorder: VueConfigReadRecorder,
): readonly VueConfigClosureEntry[] {
  return recorder.entries
    .values()
    .toArray()
    .sort((left, right) => compareCodeUnits(left.filePath, right.filePath));
}

function createIdentityId(options: {
  configClosure: readonly VueConfigClosureEntry[];
  configPath: string;
  extensions: readonly string[];
  fileNames: readonly string[];
  generation: number;
  options: ts.CompilerOptions;
  overlayFingerprint: string;
  projectReferences: readonly ts.ProjectReference[] | undefined;
  toolchain: VueSemanticToolchain;
}): string {
  return hashJson({
    adapter: options.toolchain.adapter,
    hostContract: vueCompilerPathPolicy(options).identity,
    configClosure: options.configClosure,
    configPath: options.configPath,
    extensions: options.extensions,
    fileNames: options.fileNames,
    generation: options.generation,
    options: options.options,
    overlayFingerprint: options.overlayFingerprint,
    projectReferences: options.projectReferences,
    toolchainPaths: options.toolchain.paths,
    versions: options.toolchain.versions,
  });
}

function getConfiguredExtensions(
  options: CheckerProjectConfigParseOptions,
): readonly string[] {
  return options.extensions ?? [];
}

function assertJsonConfigSourceFile(options: {
  configFile: ts.JsonSourceFile;
  configPath: string;
  host: typeof ts.sys;
}): void {
  if (Array.isArray(options.configFile.statements)) return;
  const configText = options.host.readFile(options.configPath);
  throw new TypeError(
    `Vue semantic config reader did not create a JSON source file for ${options.configPath} (${configText === undefined ? 'missing' : `${configText.length} bytes`}).`,
  );
}

interface VueConfigParserInputs {
  configPath: string;
  extensions: readonly string[];
  host: typeof ts.sys;
  rootSelectors?: ConfigRootSelector[];
  toolchain: VueSemanticToolchain;
}

export function parseVueConfigWithToolchain(
  options: VueConfigParserInputs,
): ts.ParsedCommandLine {
  return parseLiveConfig(() => readVueCommandLine(options));
}

function readVueCommandLine(
  options: VueConfigParserInputs,
): ts.ParsedCommandLine {
  return parseWithObservedConfigInputs(options.host, (host) => {
    const configFile = options.toolchain.tsModule.readJsonConfigFile(
      options.configPath,
      host.readFile,
    );
    assertJsonConfigSourceFile({
      configFile,
      configPath: options.configPath,
      host,
    });
    return observeConfigParse(
      options.configPath,
      'source-config.live-parse',
      () =>
        options.toolchain.tsModule.parseJsonSourceFileConfigFileContent(
          configFile,
          {
            ...host,
            readDirectory: (...selector) => {
              options.rootSelectors?.push(selector);
              return host.readDirectory(...selector);
            },
          },
          path.dirname(options.configPath),
          {},
          options.configPath,
          undefined,
          createVueExtraFileExtensions({
            extensions: options.extensions,
            tsModule: options.toolchain.tsModule,
          }),
        ),
    );
  });
}

function observeVueConfigBytes(entries: Iterable<VueConfigClosureEntry>): void {
  for (const { filePath, contentHash } of entries) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(filePath);
    } catch {
      throw new AnalysisInputDriftError(filePath);
    }
    const text = typeScriptBomText(bytes) ?? bytes.toString('utf8');
    if (createHash('sha256').update(text).digest('hex') !== contentHash)
      throw new AnalysisInputDriftError(filePath);
    readAnalysisFileDigest(filePath, bytes);
  }
}

function parseVueSourceConfig(
  inputs: VueConfigParserInputs,
  binding: string,
  metadata: VueConfigReadRecorder,
  vueOptions: unknown,
): ResolvedConfigProjection {
  const { configPath, extensions, toolchain } = inputs;
  const key = JSON.stringify([
    'vue-source-command-line-v2',
    binding,
    configPath,
    toolchain.tsModule.sys.getCurrentDirectory(),
    toolchain.tsModule.sys.useCaseSensitiveFileNames,
    extensions,
    getSortedConfigClosure(metadata),
    vueOptions,
  ]);
  return parseLiveConfig(
    () => {
      const contents = new Map<string, string>();
      const rootSelectors: ConfigRootSelector[] = [];
      const host = createProjectParseHost(
        undefined,
        contents,
        toolchain.tsModule,
      );
      const parsed = readVueCommandLine({ ...inputs, host, rootSelectors });
      const configClosure = [...contents].map(([filePath, text]) => ({
        filePath,
        contentHash: createHash('sha256').update(text).digest('hex'),
      }));
      const allReads = new Map(metadata.entries);
      for (const entry of configClosure) allReads.set(entry.filePath, entry);
      observeVueConfigBytes(allReads.values());
      return {
        configClosure,
        configuredVueExtensions: [],
        parsed,
        rootSelectors,
      };
    },
    key,
    { configPath, key },
  );
}

function hasConfiguredVuePlugins(recorder: VueConfigReadRecorder): boolean {
  return recorder.entries.keys().some((file) => {
    const { config, error } = readRawSourceConfig(file);
    if (error !== undefined) return true;
    const options = isPlainRecord(config)
      ? config.vueCompilerOptions
      : undefined;
    return (
      isPlainRecord(options) &&
      options.plugins !== undefined &&
      (!Array.isArray(options.plugins) || options.plugins.length > 0)
    );
  });
}

function canProjectVueConfig(
  toolchain: VueSemanticToolchain,
  vueOptions: unknown,
  recorder: VueConfigReadRecorder,
): boolean {
  const { versions } = toolchain;
  return (
    isVueCacheTuple(versions) &&
    canReuseConfigProjection(toolchain.tsModule) &&
    isPlainRecord(vueOptions) &&
    Array.isArray(vueOptions.plugins) &&
    vueOptions.plugins.length === 0 &&
    !hasConfiguredVuePlugins(recorder)
  );
}

function createIdentity(options: {
  commandLine: ReturnType<
    VueSemanticToolchain['languageCore']['createParsedCommandLine']
  >;
  configPath: string;
  extensions: readonly string[];
  generation: number;
  parsed: ts.ParsedCommandLine;
  projectRootDir: string;
  recorder: VueConfigReadRecorder;
  toolchain: VueSemanticToolchain;
  virtualFiles: ReadonlyMap<string, string>;
}): VueProjectSemanticIdentity {
  const fileNames = options.parsed.fileNames
    .map(normalizeAbsolutePath)
    .sort(compareCodeUnits);
  const configClosure = getSortedConfigClosure(options.recorder);
  const overlayFingerprint = createVueOverlayFingerprint(options.virtualFiles);
  const projectReferences = options.parsed.projectReferences;
  const profilesByFileName = createVueSourceProfiles({
    externalExtensions: options.extensions,
    fileNames,
    tsModule: options.toolchain.tsModule,
    vueOptions: options.commandLine.vueOptions,
  });
  const identityBase = {
    configClosure,
    configPath: options.configPath,
    extensions: options.extensions,
    fileNames,
    generation: options.generation,
    options: options.parsed.options,
    overlayFingerprint,
    projectReferences,
    toolchain: options.toolchain,
  };
  return {
    ...identityBase,
    id: createIdentityId(identityBase),
    profilesByFileName,
    projectRootDir: options.projectRootDir,
    virtualFiles: options.virtualFiles,
    vueOptions: options.commandLine.vueOptions,
  };
}

export function createVueProjectSemanticIdentity(
  options: SemanticProjectParseOptions,
): SemanticProjectParseResult {
  return withSourceConfigTextScope(() => parseVueProject(options));
}

function parseVueProject(
  options: SemanticProjectParseOptions,
): SemanticProjectParseResult {
  const configPath = normalizeAbsolutePath(options.configPath);
  const projectRootDirectory = normalizeAbsolutePath(options.projectRootDir);
  const toolchain = resolveVueSemanticToolchain(projectRootDirectory);
  const binding = options.bindVueSourceConfig?.(toolchain);
  const virtualFiles = normalizeVueVirtualFiles(options.virtualFiles);
  const recorder = createVueConfigReadRecorder();
  const overlay = createVueOverlaySystem({
    observeConfigReads: true,
    recorder,
    tsModule: toolchain.tsModule,
    virtualFiles,
  });
  const host = options.wrapSystem?.(overlay, toolchain) ?? overlay;
  // The 2.2 adapter enumerates roots while resolving Vue options. Only the
  // following toolchain TypeScript parse owns the final root inventory.
  const shouldSkipMetadataRoots =
    toolchain.adapter.kind === 'supported' &&
    toolchain.adapter.family === 'vue-tsc-2.2';
  const metadataHost = shouldSkipMetadataRoots
    ? { ...host, readDirectory: () => [] }
    : host;
  const commandLine = observeConfigParse(
    configPath,
    shouldSkipMetadataRoots
      ? 'source-config.vue-metadata-no-root-scan'
      : 'source-config.vue-metadata',
    () =>
      parseWithObservedConfigInputs(metadataHost, (host) =>
        toolchain.languageCore.createParsedCommandLine(
          toolchain.tsModule,
          host,
          configPath,
        ),
      ),
  );
  const extensions = normalizeExtensions([
    ...getNativeTypeScriptExtensions(toolchain.tsModule),
    ...getConfiguredExtensions(options),
    ...toolchain.languageCore.getAllExtensions(commandLine.vueOptions),
  ]);
  const rootSelectors: ConfigRootSelector[] = [];
  const inputs = { configPath, extensions, host, rootSelectors, toolchain };
  let parsed: ts.ParsedCommandLine;
  if (
    binding !== undefined &&
    virtualFiles.size === 0 &&
    options.wrapSystem === undefined &&
    canProjectVueConfig(toolchain, commandLine.vueOptions, recorder)
  ) {
    const projection = parseVueSourceConfig(
      inputs,
      binding,
      recorder,
      commandLine.vueOptions,
    );
    parsed = projection.parsed;
    rootSelectors.push(...projection.rootSelectors);
    for (const entry of projection.configClosure)
      recorder.entries.set(entry.filePath, entry);
  } else parsed = parseVueConfigWithToolchain(inputs);
  const identity = createIdentity({
    commandLine,
    configPath,
    extensions,
    generation: options.generation ?? 0,
    parsed,
    projectRootDir: projectRootDirectory,
    recorder,
    toolchain,
    virtualFiles,
  });
  return {
    diagnostics: [...parsed.errors],
    rootSelectors,
    extensions,
    identity,
    parsed,
  };
}

function assertReusableIdentity(options: {
  generation: number;
  identity: VueProjectSemanticIdentity;
  projectRootDir: string;
}): void {
  if (options.generation !== options.identity.generation) {
    throw new Error(
      `Vue semantic identity generation ${options.identity.generation} cannot serve generation ${options.generation}.`,
    );
  }
  if (options.projectRootDir !== options.identity.projectRootDir) {
    throw new Error(
      `Vue semantic identity root ${options.identity.projectRootDir} cannot serve ${options.projectRootDir}.`,
    );
  }
}

function reuseVueProjectSemanticIdentity(options: {
  identity: VueProjectSemanticIdentity;
  parseOptions: CheckerProjectConfigParseOptions;
}): SemanticProjectParseResult {
  const generation = options.parseOptions.generation ?? 0;
  const projectRootDirectory = normalizeAbsolutePath(
    options.parseOptions.projectRootDir,
  );
  assertReusableIdentity({
    generation,
    identity: options.identity,
    projectRootDir: projectRootDirectory,
  });
  const configPath = normalizeAbsolutePath(options.parseOptions.configPath);
  const virtualFiles = mergeVueVirtualFiles(
    options.identity.virtualFiles,
    options.parseOptions.virtualFiles,
  );
  const host = createVueOverlaySystem({
    observeConfigReads: true,
    tsModule: options.identity.toolchain.tsModule,
    virtualFiles,
  });
  const extensions = normalizeExtensions([
    ...options.identity.extensions,
    ...getConfiguredExtensions(options.parseOptions),
  ]);
  const rootSelectors: ConfigRootSelector[] = [];
  const parsed = parseVueConfigWithToolchain({
    configPath,
    extensions,
    host,
    rootSelectors,
    toolchain: options.identity.toolchain,
  });
  return {
    diagnostics: [...parsed.errors],
    rootSelectors,
    extensions,
    identity: options.identity,
    parsed,
  };
}

export function parseVueProjectWithSemanticIdentity(
  options: CheckerProjectConfigParseOptions,
): SemanticProjectParseResult {
  const identity = options.vueSemanticIdentity;
  return identity === undefined
    ? createVueProjectSemanticIdentity(options)
    : reuseVueProjectSemanticIdentity({ identity, parseOptions: options });
}

export function resolveVueSourceProfile(options: {
  fileName: string;
  identity: VueProjectSemanticIdentity | undefined;
}): VueSourceProfile | undefined {
  return options.identity?.profilesByFileName.get(
    normalizeAbsolutePath(options.fileName),
  );
}

export function vueCompilerPathPolicy(
  identity: Pick<
    VueProjectSemanticIdentity,
    'toolchain' | 'configPath' | 'options'
  >,
): ReturnType<typeof compilerPathPolicy> {
  return compilerPathPolicy(identity.toolchain.tsModule, {
    getCurrentDirectory: () => path.dirname(identity.configPath),
    getCanonicalFileName: identity.toolchain.tsModule.createCompilerHost(
      identity.options,
    ).getCanonicalFileName,
  });
}
