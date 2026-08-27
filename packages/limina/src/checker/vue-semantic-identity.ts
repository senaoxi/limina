import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { createHash } from 'node:crypto';
import path from 'pathe';
import type ts from 'typescript';
import { normalizeExtensions } from './extensions';
import type { CheckerProjectConfigParseOptions } from './types';
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
  diagnostics: readonly ts.Diagnostic[];
  extensions: readonly string[];
  identity: VueProjectSemanticIdentity;
  parsed: ts.ParsedCommandLine;
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function getSortedConfigClosure(
  recorder: VueConfigReadRecorder,
): readonly VueConfigClosureEntry[] {
  return [...recorder.entries.values()].sort((left, right) =>
    compareCodeUnits(left.filePath, right.filePath),
  );
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

function parseVueConfigWithToolchain(options: {
  configPath: string;
  extensions: readonly string[];
  host: typeof ts.sys;
  toolchain: VueSemanticToolchain;
}): ts.ParsedCommandLine {
  const configFile = options.toolchain.tsModule.readJsonConfigFile(
    options.configPath,
    options.host.readFile,
  );
  assertJsonConfigSourceFile({
    configFile,
    configPath: options.configPath,
    host: options.host,
  });
  return options.toolchain.tsModule.parseJsonSourceFileConfigFileContent(
    configFile,
    options.host,
    path.dirname(options.configPath),
    {},
    options.configPath,
    undefined,
    createVueExtraFileExtensions({
      extensions: options.extensions,
      tsModule: options.toolchain.tsModule,
    }),
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
  options: CheckerProjectConfigParseOptions,
): SemanticProjectParseResult {
  const configPath = normalizeAbsolutePath(options.configPath);
  const projectRootDir = normalizeAbsolutePath(options.projectRootDir);
  const toolchain = resolveVueSemanticToolchain(projectRootDir);
  const virtualFiles = normalizeVueVirtualFiles(options.virtualFiles);
  const recorder = createVueConfigReadRecorder();
  const host = createVueOverlaySystem({
    recorder,
    tsModule: toolchain.tsModule,
    virtualFiles,
  });
  const commandLine = toolchain.languageCore.createParsedCommandLine(
    toolchain.tsModule,
    host,
    configPath,
  );
  const extensions = normalizeExtensions([
    ...getNativeTypeScriptExtensions(toolchain.tsModule),
    ...getConfiguredExtensions(options),
    ...toolchain.languageCore.getAllExtensions(commandLine.vueOptions),
  ]);
  const parsed = parseVueConfigWithToolchain({
    configPath,
    extensions,
    host,
    toolchain,
  });
  const identity = createIdentity({
    commandLine,
    configPath,
    extensions,
    generation: options.generation ?? 0,
    parsed,
    projectRootDir,
    recorder,
    toolchain,
    virtualFiles,
  });
  return {
    diagnostics: [...parsed.errors],
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
  const projectRootDir = normalizeAbsolutePath(
    options.parseOptions.projectRootDir,
  );
  assertReusableIdentity({
    generation,
    identity: options.identity,
    projectRootDir,
  });
  const configPath = normalizeAbsolutePath(options.parseOptions.configPath);
  const virtualFiles = mergeVueVirtualFiles(
    options.identity.virtualFiles,
    options.parseOptions.virtualFiles,
  );
  const host = createVueOverlaySystem({
    tsModule: options.identity.toolchain.tsModule,
    virtualFiles,
  });
  const extensions = normalizeExtensions([
    ...options.identity.extensions,
    ...getConfiguredExtensions(options.parseOptions),
  ]);
  const parsed = parseVueConfigWithToolchain({
    configPath,
    extensions,
    host,
    toolchain: options.identity.toolchain,
  });
  return {
    diagnostics: [...parsed.errors],
    extensions,
    identity: options.identity,
    parsed,
  };
}

export function parseVueProjectWithSemanticIdentity(
  options: CheckerProjectConfigParseOptions,
): SemanticProjectParseResult {
  const identity = options.vueSemanticIdentity;
  if (identity === undefined) {
    return createVueProjectSemanticIdentity(options);
  }
  return reuseVueProjectSemanticIdentity({ identity, parseOptions: options });
}

export function resolveVueSourceProfile(options: {
  fileName: string;
  identity: VueProjectSemanticIdentity | undefined;
}): VueSourceProfile | undefined {
  return options.identity?.profilesByFileName.get(
    normalizeAbsolutePath(options.fileName),
  );
}
