import { getCheckerAdapter, isNativeTypeScriptProjectInput } from '#checkers';
import type {
  ResolvedCheckerConfig,
  ResolvedLiminaConfig,
} from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import {
  assertMutationAuthority,
  createExplicitMutationAuthority,
  type MutationAuthority,
  type MutationBoundarySnapshot,
  type MutationBoundaryTarget,
  preflightMutationBoundary,
  recheckMutationBoundary,
} from '#utils/mutation-boundary';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  toRelativePath,
} from '#utils/path';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'pathe';
import ts from 'typescript';
import type {
  ValidatedWorkspaceContext,
  WorkspaceOutputMutationAuthority,
} from '../core/workspace/validated-context';
import {
  assertLiminaArtifactNamespace,
  type LiminaArtifactNamespace,
} from '../domain/artifacts/namespace';
import type { TypecheckTarget } from './targets';

interface ConfigDependencyIdentity {
  readonly canonicalPath: string;
  readonly dev: string;
  readonly hash?: string;
  readonly ino: string;
  readonly kind: 'directory' | 'file' | 'symlink';
  readonly length?: number;
  readonly linkTarget?: string;
  readonly mode?: number;
  readonly nlink?: number;
  readonly path: string;
  readonly targetDev?: string;
  readonly targetHash?: string;
  readonly targetIno?: string;
  readonly targetKind?: 'directory' | 'file';
  readonly targetLength?: number;
  readonly targetMode?: number;
  readonly targetNlink?: number;
}

interface ParsedConfigProof {
  readonly configDependencies: readonly ConfigDependencyIdentity[];
  readonly parsed: ts.ParsedCommandLine;
}

interface ManagedLeafClassification {
  readonly checkerName: string;
  readonly kind: 'internal-dts' | 'user-output';
  readonly sourceConfigPath: string;
}

interface ManagedBuildStateProof {
  readonly outputPaths: readonly string[];
  readonly tsBuildInfoPath?: string;
}

export interface ProvenManagedCheckerMutationContext {
  readonly buildStateProofs: readonly ManagedBuildStateProof[];
  readonly checkerImplementationFingerprint: string;
  readonly configDependencies: readonly ConfigDependencyIdentity[];
  readonly effectiveOptionsFingerprint: string;
  readonly fingerprint: string;
  readonly inputPaths: readonly string[];
  readonly leafConfigPaths: readonly string[];
  readonly mutationTargets: readonly MutationBoundaryTarget[];
  readonly projectedOutputPaths: readonly string[];
  readonly targetId: TypecheckTarget['id'];
}

interface ManagedMutationCoordinatorOptions {
  artifactNamespace: LiminaArtifactNamespace;
  checkers: readonly ResolvedCheckerConfig[];
  config: ResolvedLiminaConfig;
  generatedGraph: GeneratedTsconfigGraphResult;
  targets: readonly TypecheckTarget[];
  workspaceContext: ValidatedWorkspaceContext;
}

export class ManagedCheckerEmitBoundaryError extends Error {
  override readonly name = 'ManagedCheckerEmitBoundaryError';
}

function isInsideOrEqual(parentPath: string, childPath: string): boolean {
  return (
    normalizeAbsolutePath(parentPath) === normalizeAbsolutePath(childPath) ||
    isPathInsideDirectory(
      normalizeAbsolutePath(childPath),
      normalizeAbsolutePath(parentPath),
    )
  );
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

let compilerIdentity: string | undefined;

function getCompilerIdentity(): string {
  if (compilerIdentity) return compilerIdentity;
  const require = createRequire(import.meta.url);
  const implementationPath = realpathSync.native(require.resolve('typescript'));
  const stats = statSync(implementationPath);
  compilerIdentity = hashValue({
    dev: String(stats.dev),
    hash: createHash('sha256')
      .update(readFileSync(implementationPath))
      .digest('hex'),
    ino: String(stats.ino),
    path: implementationPath,
    version: ts.version,
  });
  return compilerIdentity;
}

function captureConfigDependencyIdentity(
  dependencyPath: string,
): ConfigDependencyIdentity {
  const logicalPath = normalizeAbsolutePath(dependencyPath);
  const stats = lstatSync(logicalPath);
  const base = {
    canonicalPath: normalizeAbsolutePath(realpathSync.native(logicalPath)),
    dev: String(stats.dev),
    ino: String(stats.ino),
    path: logicalPath,
  };
  if (stats.isSymbolicLink()) {
    const targetStats = statSync(logicalPath);
    if (!targetStats.isDirectory() && !targetStats.isFile()) {
      throw new ManagedCheckerEmitBoundaryError(
        `Checker config dependency link has an unsupported target: ${logicalPath}.`,
      );
    }
    const targetContent = targetStats.isFile()
      ? readFileSync(logicalPath)
      : undefined;
    return {
      ...base,
      kind: 'symlink',
      linkTarget: readlinkSync(logicalPath),
      targetDev: String(targetStats.dev),
      ...(targetContent
        ? {
            targetHash: createHash('sha256')
              .update(targetContent)
              .digest('hex'),
            targetLength: targetContent.byteLength,
            targetMode: targetStats.mode & 0o7777,
            targetNlink: targetStats.nlink,
          }
        : {}),
      targetIno: String(targetStats.ino),
      targetKind: targetStats.isDirectory() ? 'directory' : 'file',
    };
  }
  if (stats.isDirectory()) {
    return { ...base, kind: 'directory' };
  }
  if (!stats.isFile()) {
    throw new ManagedCheckerEmitBoundaryError(
      `Checker config dependency is not a regular file: ${logicalPath}.`,
    );
  }
  const content = readFileSync(logicalPath);
  return {
    ...base,
    hash: createHash('sha256').update(content).digest('hex'),
    kind: 'file',
    length: content.byteLength,
    mode: stats.mode & 0o7777,
    nlink: stats.nlink,
  };
}

function resolveCheckerPackageManifest(options: {
  packageName: string;
  projectRootDir: string;
}): string | undefined {
  const requireFromProject = createRequire(
    path.join(options.projectRootDir, 'package.json'),
  );
  try {
    return normalizeAbsolutePath(
      requireFromProject.resolve(`${options.packageName}/package.json`),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (String(error.code) === 'ERR_PACKAGE_PATH_NOT_EXPORTED' ||
        String(error.code) === 'MODULE_NOT_FOUND')
    ) {
      return undefined;
    }
    throw error;
  }
}

function getCheckerImplementationFingerprint(options: {
  checker: ResolvedCheckerConfig;
  projectRootDir: string;
  target: TypecheckTarget;
}): string {
  const adapter = getCheckerAdapter(options.checker.preset);
  if (!adapter) {
    throw new ManagedCheckerEmitBoundaryError(
      `Unable to identify checker implementation for ${options.checker.preset}.`,
    );
  }
  const packageIdentities = adapter.packageNames.map((packageName) => {
    const manifestPath = resolveCheckerPackageManifest({
      packageName,
      projectRootDir: options.projectRootDir,
    });
    return manifestPath
      ? {
          identity: captureConfigDependencyIdentity(manifestPath),
          packageName,
        }
      : { packageName, resolution: 'externally-resolved' as const };
  });
  const commandPath = path.isAbsolute(options.target.command)
    ? normalizeAbsolutePath(options.target.command)
    : normalizeAbsolutePath(
        path.join(
          options.projectRootDir,
          'node_modules',
          '.bin',
          options.target.command,
        ),
      );
  const commandIdentity = (() => {
    try {
      return captureConfigDependencyIdentity(commandPath);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        String(error.code) === 'ENOENT'
      ) {
        return { command: options.target.command, resolution: 'path-search' };
      }
      throw error;
    }
  })();

  return hashValue({
    commandIdentity,
    packageIdentities,
    preset: options.checker.preset,
    projectionCompiler: getCompilerIdentity(),
    projectionCompilerVersion: ts.version,
  });
}

function parseConfigWithDependencyProof(configPath: string): ParsedConfigProof {
  const reads = new Set<string>();
  const diagnostics: ts.Diagnostic[] = [];
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic): void {
      diagnostics.push(diagnostic);
    },
    readFile(fileName): string | undefined {
      const content = ts.sys.readFile(fileName);
      if (content !== undefined) reads.add(normalizeAbsolutePath(fileName));
      return content;
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
  if (!parsed) {
    throw new ManagedCheckerEmitBoundaryError(
      `Unable to parse generated checker config: ${configPath}.`,
    );
  }
  if (parsed.options.outFile !== undefined) {
    throw new ManagedCheckerEmitBoundaryError(
      [
        'Managed checker effective compiler options contain outFile:',
        `  config: ${configPath}`,
        `  outFile: ${parsed.options.outFile}`,
        '  reason: outFile is not an authorized Limina managed-output namespace.',
      ].join('\n'),
    );
  }
  const errors = [...diagnostics, ...parsed.errors].filter(
    (diagnostic) =>
      !(
        diagnostic.code === 18_002 &&
        parsed.fileNames.length === 0 &&
        normalizeAbsolutePath(configPath).split(path.sep).includes('.limina')
      ),
  );
  if (errors.length > 0) {
    throw new ManagedCheckerEmitBoundaryError(
      ts.formatDiagnosticsWithColorAndContext(errors, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => path.dirname(configPath),
        getNewLine: () => '\n',
      }),
    );
  }
  reads.add(normalizeAbsolutePath(configPath));
  return {
    configDependencies: [...reads]
      .sort((left, right) => left.localeCompare(right))
      .map(captureConfigDependencyIdentity),
    parsed,
  };
}

function collectLeafClassifications(
  graph: GeneratedTsconfigGraphResult,
): Map<string, ManagedLeafClassification> {
  const classifications = new Map<string, ManagedLeafClassification>();
  for (const [checkerName, buildsBySource] of graph.configToOutputBuild) {
    for (const [sourceConfigPath, buildModule] of buildsBySource) {
      if (buildModule.kind !== 'project') continue;
      classifications.set(normalizeAbsolutePath(buildModule.path), {
        checkerName,
        kind: 'user-output',
        sourceConfigPath: normalizeAbsolutePath(sourceConfigPath),
      });
    }
  }
  for (const [checkerName, dtsToSource] of graph.dtsToSource) {
    for (const [dtsConfigPath, sourceConfigPath] of dtsToSource) {
      classifications.set(normalizeAbsolutePath(dtsConfigPath), {
        checkerName,
        kind: 'internal-dts',
        sourceConfigPath: normalizeAbsolutePath(sourceConfigPath),
      });
    }
  }
  return classifications;
}

function collectTargetLeafConfigs(options: {
  classifications: ReadonlyMap<string, ManagedLeafClassification>;
  rootConfigPath: string;
}): {
  dependencies: ConfigDependencyIdentity[];
  leafPaths: string[];
} {
  const queue = [normalizeAbsolutePath(options.rootConfigPath)];
  const seen = new Set<string>();
  const leafPaths = new Set<string>();
  const dependencies = new Map<string, ConfigDependencyIdentity>();

  while (queue.length > 0) {
    const configPath = queue.shift()!;
    if (seen.has(configPath)) continue;
    seen.add(configPath);
    const proof = parseConfigWithDependencyProof(configPath);
    for (const dependency of proof.configDependencies) {
      dependencies.set(dependency.path, dependency);
    }
    if (options.classifications.has(configPath)) leafPaths.add(configPath);
    for (const reference of proof.parsed.projectReferences ?? []) {
      queue.push(normalizeAbsolutePath(reference.path));
    }
  }

  return {
    dependencies: [...dependencies.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
    leafPaths: [...leafPaths].sort((left, right) => left.localeCompare(right)),
  };
}

function resolveOutputAuthority(options: {
  outputRoot: string;
  sourceConfigPath: string;
  workspaceContext: ValidatedWorkspaceContext;
}): WorkspaceOutputMutationAuthority {
  const capability = options.workspaceContext.outputMutationAuthorities?.get(
    normalizeAbsolutePath(options.sourceConfigPath),
  );
  if (!capability) {
    throw new ManagedCheckerEmitBoundaryError(
      `Missing validated output mutation authority for ${options.sourceConfigPath}.`,
    );
  }
  if (
    capability.workspaceGeneration !==
      options.workspaceContext.workspaceMutationGeneration ||
    capability.declaringSourceConfig !==
      normalizeAbsolutePath(options.sourceConfigPath) ||
    capability.outputRoot !== normalizeAbsolutePath(options.outputRoot)
  ) {
    throw new ManagedCheckerEmitBoundaryError(
      `Output mutation authority binding drifted for ${options.sourceConfigPath}.`,
    );
  }
  assertMutationAuthority(capability.authority);
  return capability;
}

async function createArtifactDirectoryAuthority(options: {
  artifactNamespace: LiminaArtifactNamespace;
  directoryPath: string;
  expectedNamespace: string;
}): Promise<MutationAuthority> {
  assertLiminaArtifactNamespace(options.artifactNamespace);
  const directoryPath = normalizeAbsolutePath(options.directoryPath);
  const expectedRoot = normalizeAbsolutePath(
    path.join(options.artifactNamespace.rootDir, options.expectedNamespace),
  );
  if (!isInsideOrEqual(expectedRoot, directoryPath)) {
    throw new ManagedCheckerEmitBoundaryError(
      `Managed checker directory escapes its artifact runtime authority: ${directoryPath}.`,
    );
  }
  return createExplicitMutationAuthority({
    generation: `${options.artifactNamespace.generation}:${options.artifactNamespace.generationToken.nonce}`,
    logicalMutationRoot: directoryPath,
    scope: 'directory',
    trustedBasePath: options.artifactNamespace.configRootDir,
  });
}

async function createArtifactFileAuthority(options: {
  artifactNamespace: LiminaArtifactNamespace;
  expectedNamespace: string;
  filePath: string;
}): Promise<MutationAuthority> {
  assertLiminaArtifactNamespace(options.artifactNamespace);
  const filePath = normalizeAbsolutePath(options.filePath);
  const expectedRoot = normalizeAbsolutePath(
    path.join(options.artifactNamespace.rootDir, options.expectedNamespace),
  );
  if (!isInsideOrEqual(expectedRoot, filePath) || filePath === expectedRoot) {
    throw new ManagedCheckerEmitBoundaryError(
      `Managed checker file escapes its artifact runtime authority: ${filePath}.`,
    );
  }
  return createExplicitMutationAuthority({
    generation: `${options.artifactNamespace.generation}:${options.artifactNamespace.generationToken.nonce}`,
    logicalMutationRoot: filePath,
    scope: 'file',
    trustedBasePath: options.artifactNamespace.configRootDir,
  });
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
        {
          errors: [],
          fileNames: [...options.fileNames],
          options: {
            ...options.compilerOptions,
            configFilePath: options.configPath,
          },
          projectReferences: options.projectReferences
            ? [...options.projectReferences]
            : undefined,
        },
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

function assertProjectedInside(options: {
  authorityRoot: string;
  configPath: string;
  outputPath: string;
}): void {
  if (!isInsideOrEqual(options.authorityRoot, options.outputPath)) {
    throw new ManagedCheckerEmitBoundaryError(
      [
        'Managed checker projected an output outside its authenticated authority:',
        `  config: ${options.configPath}`,
        `  output: ${options.outputPath}`,
        `  authority root: ${options.authorityRoot}`,
      ].join('\n'),
    );
  }
}

async function proveLeafMutation(options: {
  artifactNamespace: LiminaArtifactNamespace;
  checker: ResolvedCheckerConfig;
  classification: ManagedLeafClassification;
  configPath: string;
  projectRootDir: string;
  workspaceContext: ValidatedWorkspaceContext;
}): Promise<{
  buildStateProof: ManagedBuildStateProof;
  configDependencies: ConfigDependencyIdentity[];
  effectiveOptionsFingerprint: string;
  inputPaths: string[];
  mutationTargets: MutationBoundaryTarget[];
  projectedOutputPaths: string[];
}> {
  const adapter = getCheckerAdapter(options.checker.preset);
  if (!adapter || adapter.execution !== 'build') {
    throw new ManagedCheckerEmitBoundaryError(
      `Managed emit proof requires a build-capable checker: ${options.checker.name}.`,
    );
  }
  const parsedProof = parseConfigWithDependencyProof(options.configPath);
  const parsed = adapter.parseProjectConfig({
    configPath: options.configPath,
    extensions: options.checker.extensions,
    projectRootDir: options.projectRootDir,
  });
  if (parsed.options.outFile !== undefined) {
    throw new ManagedCheckerEmitBoundaryError(
      `Managed checker effective outFile is not supported: ${parsed.options.outFile}.`,
    );
  }
  const outDir = parsed.options.outDir
    ? normalizeAbsolutePath(parsed.options.outDir)
    : undefined;
  if (!outDir) {
    throw new ManagedCheckerEmitBoundaryError(
      `Managed checker project has no effective outDir: ${options.configPath}.`,
    );
  }

  const outputAuthority =
    options.classification.kind === 'user-output'
      ? resolveOutputAuthority({
          outputRoot: outDir,
          sourceConfigPath: options.classification.sourceConfigPath,
          workspaceContext: options.workspaceContext,
        }).authority
      : await createArtifactDirectoryAuthority({
          artifactNamespace: options.artifactNamespace,
          directoryPath: outDir,
          expectedNamespace: path.join('dts', 'checkers'),
        });
  const projectedOutputs = new Set<string>();
  let usesBoundedVueDirectory = false;
  const rootDir = parsed.options.rootDir
    ? normalizeAbsolutePath(parsed.options.rootDir)
    : undefined;

  for (const fileNameValue of parsed.fileNames) {
    const fileName = normalizeAbsolutePath(fileNameValue);
    const adapterExtraInput =
      !isNativeTypeScriptProjectInput(fileName) &&
      isAdapterExtraInput({
        adapterExtensions: parsed.extensions,
        fileName,
      });

    if (adapterExtraInput && adapter.emitProjection === 'vue-bounded') {
      if (!rootDir || !isInsideOrEqual(rootDir, fileName)) {
        throw new ManagedCheckerEmitBoundaryError(
          [
            'Vue checker input cannot be proven inside the configured emit root:',
            `  config: ${options.configPath}`,
            `  input: ${fileName}`,
            `  rootDir: ${rootDir ?? '(missing)'}`,
          ].join('\n'),
        );
      }
      usesBoundedVueDirectory = true;
      continue;
    }
    for (const outputPath of projectTypeScriptOutputs({
      compilerOptions: parsed.options,
      configPath: options.configPath,
      fileName,
      fileNames: parsed.fileNames,
      projectReferences: parsedProof.parsed.projectReferences,
    })) {
      projectedOutputs.add(outputPath);
    }
  }

  const tsBuildInfoFile = parsed.options.tsBuildInfoFile
    ? normalizeAbsolutePath(parsed.options.tsBuildInfoFile)
    : undefined;
  if (tsBuildInfoFile) projectedOutputs.delete(tsBuildInfoFile);
  for (const outputPath of projectedOutputs) {
    assertProjectedInside({
      authorityRoot: outDir,
      configPath: options.configPath,
      outputPath,
    });
  }

  const outputPaths = [...projectedOutputs].sort();
  const mutationTargets: MutationBoundaryTarget[] = [];
  if (projectedOutputs.size > 0 || usesBoundedVueDirectory) {
    mutationTargets.push({
      authority: outputAuthority,
      kind: 'directory',
      path: outDir,
      recursive: true,
    });
    for (const outputPath of projectedOutputs) {
      mutationTargets.push({
        authority: outputAuthority,
        kind: 'file',
        path: outputPath,
      });
    }
  }

  if (tsBuildInfoFile) {
    const buildInfoAuthority = await createArtifactFileAuthority({
      artifactNamespace: options.artifactNamespace,
      expectedNamespace:
        options.classification.kind === 'user-output'
          ? path.join('tsbuildinfo', 'build')
          : path.join('tsbuildinfo', 'checkers'),
      filePath: tsBuildInfoFile,
    });
    mutationTargets.push({
      authority: buildInfoAuthority,
      kind: 'file',
      path: tsBuildInfoFile,
    });
    projectedOutputs.add(tsBuildInfoFile);
  }

  return {
    buildStateProof:
      options.classification.kind === 'user-output'
        ? {
            outputPaths,
            ...(tsBuildInfoFile ? { tsBuildInfoPath: tsBuildInfoFile } : {}),
          }
        : { outputPaths: [] },
    configDependencies: [...parsedProof.configDependencies],
    effectiveOptionsFingerprint: hashValue({
      adapterExtensions: parsed.extensions,
      compilerOptions: parsed.options,
      projectReferences: parsedProof.parsed.projectReferences?.map(
        (reference) => normalizeAbsolutePath(reference.path),
      ),
    }),
    inputPaths: parsed.fileNames.map(normalizeAbsolutePath).sort(),
    mutationTargets,
    projectedOutputPaths: [...projectedOutputs].sort(),
  };
}

function checkerForTarget(options: {
  checkers: readonly ResolvedCheckerConfig[];
  target: TypecheckTarget;
}): ResolvedCheckerConfig {
  const checker = options.checkers.find(
    (candidate) => candidate.name === options.target.checkerName,
  );
  if (!checker) {
    throw new ManagedCheckerEmitBoundaryError(
      `Unable to resolve checker for managed target ${options.target.id}.`,
    );
  }
  return checker;
}

export async function proveManagedCheckerMutationContext(options: {
  artifactNamespace: LiminaArtifactNamespace;
  checkers: readonly ResolvedCheckerConfig[];
  generatedGraph: GeneratedTsconfigGraphResult;
  projectRootDir: string;
  target: TypecheckTarget;
  workspaceContext: ValidatedWorkspaceContext;
}): Promise<ProvenManagedCheckerMutationContext> {
  const classifications = collectLeafClassifications(options.generatedGraph);
  const closure = collectTargetLeafConfigs({
    classifications,
    rootConfigPath: options.target.configPath,
  });
  const checker = checkerForTarget({
    checkers: options.checkers,
    target: options.target,
  });
  const checkerImplementationFingerprint = getCheckerImplementationFingerprint({
    checker,
    projectRootDir: options.projectRootDir,
    target: options.target,
  });
  if (closure.leafPaths.length === 0) {
    const effectiveOptionsFingerprint = hashValue([]);
    const fingerprint = hashValue({
      checker: {
        implementation: checkerImplementationFingerprint,
        name: checker.name,
        preset: checker.preset,
        typescriptVersion: ts.version,
      },
      configDependencies: closure.dependencies,
      effectiveOptionsFingerprint,
      inputPaths: [],
      leafConfigPaths: [],
      projectedOutputPaths: [],
      target: {
        configPath: options.target.configPath,
        id: options.target.id,
        sourceConfigPath: options.target.sourceConfigPath,
      },
      workspaceGeneration: options.workspaceContext.workspaceMutationGeneration,
    });
    return {
      buildStateProofs: [],
      checkerImplementationFingerprint,
      configDependencies: closure.dependencies,
      effectiveOptionsFingerprint,
      fingerprint,
      inputPaths: [],
      leafConfigPaths: [],
      mutationTargets: [],
      projectedOutputPaths: [],
      targetId: options.target.id,
    };
  }
  const leafProofs = await Promise.all(
    closure.leafPaths.map(async (configPath) => {
      const classification = classifications.get(configPath)!;
      return proveLeafMutation({
        artifactNamespace: options.artifactNamespace,
        checker,
        classification,
        configPath,
        projectRootDir: options.projectRootDir,
        workspaceContext: options.workspaceContext,
      });
    }),
  );
  const buildStateProofs = leafProofs.map((leaf) => leaf.buildStateProof);
  const dependencies = new Map<string, ConfigDependencyIdentity>(
    closure.dependencies.map((dependency) => [dependency.path, dependency]),
  );
  for (const leaf of leafProofs) {
    for (const dependency of leaf.configDependencies) {
      dependencies.set(dependency.path, dependency);
    }
  }
  const inputPaths = [
    ...new Set(leafProofs.flatMap((leaf) => leaf.inputPaths)),
  ].sort((left, right) => left.localeCompare(right));
  const projectedOutputPaths = [
    ...new Set(leafProofs.flatMap((leaf) => leaf.projectedOutputPaths)),
  ].sort((left, right) => left.localeCompare(right));
  const mutationTargets = leafProofs.flatMap((leaf) => leaf.mutationTargets);
  const configDependencies = [...dependencies.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const effectiveOptionsFingerprint = hashValue(
    leafProofs.map((leaf) => leaf.effectiveOptionsFingerprint).sort(),
  );
  const fingerprint = hashValue({
    checker: {
      implementation: checkerImplementationFingerprint,
      name: checker.name,
      preset: checker.preset,
      typescriptVersion: ts.version,
    },
    configDependencies,
    effectiveOptionsFingerprint,
    inputPaths,
    leafConfigPaths: closure.leafPaths,
    projectedOutputPaths,
    target: {
      configPath: options.target.configPath,
      id: options.target.id,
      sourceConfigPath: options.target.sourceConfigPath,
    },
    workspaceGeneration: options.workspaceContext.workspaceMutationGeneration,
  });

  return {
    buildStateProofs,
    checkerImplementationFingerprint,
    configDependencies,
    effectiveOptionsFingerprint,
    fingerprint,
    inputPaths,
    leafConfigPaths: closure.leafPaths,
    mutationTargets,
    projectedOutputPaths,
    targetId: options.target.id,
  };
}

function collectStaleBuildInfoTargets(
  proofs: readonly ProvenManagedCheckerMutationContext[],
): MutationBoundaryTarget[] {
  const targetsByPath = new Map<string, MutationBoundaryTarget>();

  for (const proof of proofs) {
    for (const buildState of proof.buildStateProofs) {
      const buildInfoPath = buildState.tsBuildInfoPath;
      if (
        !buildInfoPath ||
        !existsSync(buildInfoPath) ||
        buildState.outputPaths.every((outputPath) => existsSync(outputPath))
      ) {
        continue;
      }

      const boundaryTarget = proof.mutationTargets.find(
        (target) =>
          target.kind === 'file' &&
          normalizeAbsolutePath(target.path) === buildInfoPath,
      );
      if (!boundaryTarget) {
        throw new ManagedCheckerEmitBoundaryError(
          `Managed checker build info has no authenticated mutation target: ${buildInfoPath}.`,
        );
      }
      targetsByPath.set(buildInfoPath, boundaryTarget);
    }
  }

  return [...targetsByPath.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

async function invalidateStaleBuildInfo(
  proofs: readonly ProvenManagedCheckerMutationContext[],
): Promise<void> {
  const staleTargets = collectStaleBuildInfoTargets(proofs);
  if (staleTargets.length === 0) return;

  await preflightMutationBoundary(staleTargets);
  const snapshots = new Map<string, MutationBoundarySnapshot>();
  for (const target of staleTargets) {
    snapshots.set(target.path, await preflightMutationBoundary([target]));
  }
  for (const target of staleTargets) {
    await recheckMutationBoundary(snapshots.get(target.path)!);
    await rm(target.path, { force: true });
  }
}

export class ManagedCheckerMutationCoordinator {
  readonly #initialProofs: ReadonlyMap<
    TypecheckTarget['id'],
    ProvenManagedCheckerMutationContext
  >;
  readonly #layerProofs = new Map<
    TypecheckTarget['id'],
    ProvenManagedCheckerMutationContext
  >();
  readonly #layerSnapshots = new Map<
    TypecheckTarget['id'],
    MutationBoundarySnapshot
  >();
  readonly #options: ManagedMutationCoordinatorOptions;

  private constructor(
    options: ManagedMutationCoordinatorOptions,
    initialProofs: ReadonlyMap<
      TypecheckTarget['id'],
      ProvenManagedCheckerMutationContext
    >,
  ) {
    this.#options = options;
    this.#initialProofs = initialProofs;
  }

  static async create(
    options: ManagedMutationCoordinatorOptions,
  ): Promise<ManagedCheckerMutationCoordinator> {
    const initialProofs = new Map<
      TypecheckTarget['id'],
      ProvenManagedCheckerMutationContext
    >();
    for (const target of options.targets) {
      initialProofs.set(
        target.id,
        await proveManagedCheckerMutationContext({
          artifactNamespace: options.artifactNamespace,
          checkers: options.checkers,
          generatedGraph: options.generatedGraph,
          projectRootDir: options.config.rootDir,
          target,
          workspaceContext: options.workspaceContext,
        }),
      );
    }
    await preflightMutationBoundary(
      [...initialProofs.values()].flatMap((proof) => proof.mutationTargets),
    );
    return new ManagedCheckerMutationCoordinator(options, initialProofs);
  }

  async beforeLayerRun(targets: readonly TypecheckTarget[]): Promise<void> {
    const layerProofs: ProvenManagedCheckerMutationContext[] = [];
    for (const target of targets) {
      const current = await this.#prove(target);
      const initial = this.#initialProofs.get(target.id);
      if (!initial || current.fingerprint !== initial.fingerprint) {
        throw new ManagedCheckerEmitBoundaryError(
          `Managed checker emit proof drifted before provider layer: ${toRelativePath(this.#options.config.rootDir, target.configPath)}.`,
        );
      }
      this.#layerProofs.set(target.id, current);
      layerProofs.push(current);
    }
    await preflightMutationBoundary(
      layerProofs.flatMap((proof) => proof.mutationTargets),
    );
    await invalidateStaleBuildInfo(layerProofs);
    for (const proof of layerProofs) {
      this.#layerSnapshots.set(
        proof.targetId,
        await preflightMutationBoundary(proof.mutationTargets),
      );
    }
  }

  async beforeTargetRun(target: TypecheckTarget): Promise<void> {
    const current = await this.#prove(target);
    const expected =
      this.#layerProofs.get(target.id) ?? this.#initialProofs.get(target.id);
    if (!expected || current.fingerprint !== expected.fingerprint) {
      throw new ManagedCheckerEmitBoundaryError(
        `Managed checker emit proof drifted immediately before runner: ${toRelativePath(this.#options.config.rootDir, target.configPath)}.`,
      );
    }
    const layerSnapshot = this.#layerSnapshots.get(target.id);
    if (!layerSnapshot) {
      throw new ManagedCheckerEmitBoundaryError(
        `Managed checker target has no provider-layer boundary snapshot: ${toRelativePath(this.#options.config.rootDir, target.configPath)}.`,
      );
    }
    await recheckMutationBoundary(layerSnapshot);
  }

  async #prove(
    target: TypecheckTarget,
  ): Promise<ProvenManagedCheckerMutationContext> {
    return proveManagedCheckerMutationContext({
      artifactNamespace: this.#options.artifactNamespace,
      checkers: this.#options.checkers,
      generatedGraph: this.#options.generatedGraph,
      projectRootDir: this.#options.config.rootDir,
      target,
      workspaceContext: this.#options.workspaceContext,
    });
  }
}
