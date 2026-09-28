import { isNativeTypeScriptProjectInput } from '#checkers';
import type {
  MutationAuthority,
  MutationBoundaryTarget,
} from '#utils/mutation-boundary';
import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import ts from 'typescript';
import type { ValidatedWorkspaceContext } from '../../core/workspace/validated-context';
import type { LiminaArtifactNamespace } from '../../domain/artifacts/namespace';
import {
  assertProjectedInside,
  createArtifactDirectoryAuthority,
  createArtifactFileAuthority,
  isInsideOrEqual,
  resolveOutputAuthority,
} from './authority';
import {
  ManagedCheckerEmitBoundaryError,
  type ManagedLeafClassification,
} from './types';

export interface ManagedOutputProjection {
  projectedOutputs: Set<string>;
  usesBoundedVueDirectory: boolean;
}

export function getEffectiveOutDir(
  configPath: string,
  compilerOptions: ts.CompilerOptions,
): string {
  if (compilerOptions.outDir !== undefined) {
    return normalizeAbsolutePath(compilerOptions.outDir);
  }
  throw new ManagedCheckerEmitBoundaryError(
    `Managed checker project has no effective outDir: ${configPath}.`,
  );
}

export async function getOutputAuthority(options: {
  artifactNamespace: LiminaArtifactNamespace;
  classification: ManagedLeafClassification;
  outDir: string;
  workspaceContext: ValidatedWorkspaceContext;
}): Promise<MutationAuthority> {
  if (options.classification.kind === 'user-output') {
    return resolveOutputAuthority({
      outputRoot: options.outDir,
      sourceConfigPath: options.classification.sourceConfigPath,
      workspaceContext: options.workspaceContext,
    }).authority;
  }
  return createArtifactDirectoryAuthority({
    artifactNamespace: options.artifactNamespace,
    directoryPath: options.outDir,
    expectedNamespace: path.join('dts', 'checkers'),
  });
}

function createOutputProjectionCommandLine(options: {
  configPath: string;
  fileNames: readonly string[];
  compilerOptions: ts.CompilerOptions;
  projectReferences?: readonly ts.ProjectReference[];
}): ts.ParsedCommandLine {
  return {
    errors: [],
    fileNames: [...options.fileNames],
    options: {
      ...options.compilerOptions,
      configFilePath: options.configPath,
    },
    projectReferences:
      options.projectReferences === undefined
        ? undefined
        : [...options.projectReferences],
  };
}

function projectTypeScriptOutputs(options: {
  configPath: string;
  fileName: string;
  fileNames: readonly string[];
  compilerOptions: ts.CompilerOptions;
  projectReferences?: readonly ts.ProjectReference[];
}): string[] {
  try {
    return ts
      .getOutputFileNames(
        createOutputProjectionCommandLine(options),
        options.fileName,
        !ts.sys.useCaseSensitiveFileNames,
      )
      .map(normalizeAbsolutePath);
  } catch (error) {
    throw new ManagedCheckerEmitBoundaryError(
      `Unable to project compiler outputs for ${options.fileName}: ${String(error)}`,
    );
  }
}

function isAdapterExtraInput(options: {
  adapterExtensions: readonly string[];
  fileName: string;
}): boolean {
  const lowerFileName = options.fileName.toLowerCase();
  return options.adapterExtensions.some((extension) =>
    lowerFileName.endsWith(extension.toLowerCase()),
  );
}

function isBoundedVueInput(options: {
  adapterExtensions: readonly string[];
  emitProjection: string | undefined;
  fileName: string;
}): boolean {
  if (isNativeTypeScriptProjectInput(options.fileName)) return false;
  if (!isAdapterExtraInput(options)) return false;
  return options.emitProjection === 'vue-bounded';
}

function formatRootDir(rootDir: string | undefined): string {
  return rootDir === undefined ? '(missing)' : rootDir;
}

function assertVueInputInsideRoot(options: {
  configPath: string;
  fileName: string;
  rootDir: string | undefined;
}): void {
  if (options.rootDir !== undefined) {
    if (isInsideOrEqual(options.rootDir, options.fileName)) return;
  }
  throw new ManagedCheckerEmitBoundaryError(
    [
      'Vue checker input cannot be proven inside the configured emit root:',
      `  config: ${options.configPath}`,
      `  input: ${options.fileName}`,
      `  rootDir: ${formatRootDir(options.rootDir)}`,
    ].join('\n'),
  );
}

function addProjectedOutputs(
  state: ManagedOutputProjection,
  outputs: readonly string[],
): void {
  for (const outputPath of outputs) {
    state.projectedOutputs.add(outputPath);
  }
}

function projectInput(options: {
  adapterExtensions: readonly string[];
  compilerOptions: ts.CompilerOptions;
  configPath: string;
  emitProjection: string | undefined;
  fileNameValue: string;
  fileNames: readonly string[];
  projectReferences?: readonly ts.ProjectReference[];
  rootDir: string | undefined;
  state: ManagedOutputProjection;
}): void {
  const fileName = normalizeAbsolutePath(options.fileNameValue);
  if (
    isBoundedVueInput({
      adapterExtensions: options.adapterExtensions,
      emitProjection: options.emitProjection,
      fileName,
    })
  ) {
    assertVueInputInsideRoot({
      configPath: options.configPath,
      fileName,
      rootDir: options.rootDir,
    });
    options.state.usesBoundedVueDirectory = true;
    return;
  }
  addProjectedOutputs(
    options.state,
    projectTypeScriptOutputs({
      compilerOptions: options.compilerOptions,
      configPath: options.configPath,
      fileName,
      fileNames: options.fileNames,
      projectReferences: options.projectReferences,
    }),
  );
}

function getCompilerRootDir(
  compilerOptions: ts.CompilerOptions,
): string | undefined {
  if (compilerOptions.rootDir === undefined) return undefined;
  return normalizeAbsolutePath(compilerOptions.rootDir);
}

export function collectProjectedOutputs(options: {
  adapterExtensions: readonly string[];
  compilerOptions: ts.CompilerOptions;
  configPath: string;
  emitProjection: string | undefined;
  fileNames: readonly string[];
  projectReferences?: readonly ts.ProjectReference[];
}): ManagedOutputProjection {
  const state: ManagedOutputProjection = {
    projectedOutputs: new Set(),
    usesBoundedVueDirectory: false,
  };
  const rootDir = getCompilerRootDir(options.compilerOptions);
  for (const fileNameValue of options.fileNames) {
    projectInput({ ...options, fileNameValue, rootDir, state });
  }
  return state;
}

function shouldAddOutputTargets(options: {
  outputPaths: readonly string[];
  usesBoundedVueDirectory: boolean;
}): boolean {
  if (options.outputPaths.length > 0) return true;
  return options.usesBoundedVueDirectory;
}

export function addOutputMutationTargets(options: {
  authority: MutationAuthority;
  outDir: string;
  outputPaths: readonly string[];
  targets: MutationBoundaryTarget[];
  usesBoundedVueDirectory: boolean;
}): void {
  if (!shouldAddOutputTargets(options)) return;
  options.targets.push({
    authority: options.authority,
    kind: 'directory',
    path: options.outDir,
    recursive: true,
  });
  for (const outputPath of options.outputPaths) {
    options.targets.push({
      authority: options.authority,
      kind: 'file',
      path: outputPath,
    });
  }
}

function getBuildInfoNamespace(
  classification: ManagedLeafClassification,
): string {
  return classification.kind === 'user-output'
    ? path.join('tsbuildinfo', 'build')
    : path.join('tsbuildinfo', 'checkers');
}

export async function addBuildInfoTarget(options: {
  artifactNamespace: LiminaArtifactNamespace;
  classification: ManagedLeafClassification;
  projectedOutputs: Set<string>;
  targets: MutationBoundaryTarget[];
  tsBuildInfoFile: string | undefined;
}): Promise<void> {
  if (options.tsBuildInfoFile === undefined) return;
  const authority = await createArtifactFileAuthority({
    artifactNamespace: options.artifactNamespace,
    expectedNamespace: getBuildInfoNamespace(options.classification),
    filePath: options.tsBuildInfoFile,
  });
  options.targets.push({
    authority,
    kind: 'file',
    path: options.tsBuildInfoFile,
  });
  options.projectedOutputs.add(options.tsBuildInfoFile);
}

export function assertProjectionInside(options: {
  configPath: string;
  outDir: string;
  projection: ManagedOutputProjection;
}): void {
  for (const outputPath of options.projection.projectedOutputs) {
    assertProjectedInside({
      authorityRoot: options.outDir,
      configPath: options.configPath,
      outputPath,
    });
  }
}
