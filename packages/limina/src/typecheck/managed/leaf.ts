import { getCheckerAdapter } from '#checkers';
import type { ResolvedCheckerConfig } from '#config/runner';
import type { MutationBoundaryTarget } from '#utils/mutation-boundary';
import { normalizeAbsolutePath } from '#utils/path';
import type { ValidatedWorkspaceContext } from '../../core/workspace/validated-context';
import type { LiminaArtifactNamespace } from '../../domain/artifacts/namespace';
import { parseConfigWithDependencyProof } from './config';
import { hashValue } from './identity';
import {
  addBuildInfoTarget,
  addOutputMutationTargets,
  assertProjectionInside,
  collectProjectedOutputs,
  getEffectiveOutDir,
  getOutputAuthority,
  type ManagedOutputProjection,
} from './projection';
import {
  ManagedCheckerEmitBoundaryError,
  type ManagedLeafClassification,
  type ManagedLeafMutationProof,
  type ParsedConfigProof,
} from './types';

type BuildAdapter = NonNullable<ReturnType<typeof getCheckerAdapter>>;
type ParsedProject = ReturnType<BuildAdapter['parseProjectConfig']>;

interface LeafPreparation {
  adapter: BuildAdapter;
  parsed: ParsedProject;
  parsedProof: ParsedConfigProof;
}

function requireBuildAdapter(checker: ResolvedCheckerConfig): BuildAdapter {
  const adapter = getCheckerAdapter(checker.name);
  if (adapter !== null) {
    if (adapter.execution === 'build') return adapter;
  }
  throw new ManagedCheckerEmitBoundaryError(
    `Managed emit proof requires a build-capable checker: ${checker.name}.`,
  );
}

function assertNoOutFile(parsed: ParsedProject): void {
  if (parsed.options.outFile === undefined) return;
  throw new ManagedCheckerEmitBoundaryError(
    `Managed checker effective outFile is not supported: ${parsed.options.outFile}.`,
  );
}

function prepareLeafProject(options: {
  checker: ResolvedCheckerConfig;
  configPath: string;
  projectRootDir: string;
}): LeafPreparation {
  const adapter = requireBuildAdapter(options.checker);
  const parsedProof = parseConfigWithDependencyProof(options.configPath);
  const parsed = adapter.parseProjectConfig({
    configPath: options.configPath,
    extensions: options.checker.extensions,
    projectRootDir: options.projectRootDir,
  });
  assertNoOutFile(parsed);
  return { adapter, parsed, parsedProof };
}

function getBuildInfoFile(parsed: ParsedProject): string | undefined {
  if (parsed.options.tsBuildInfoFile === undefined) return undefined;
  return normalizeAbsolutePath(parsed.options.tsBuildInfoFile);
}

function removeBuildInfoFromProjection(
  projection: ManagedOutputProjection,
  tsBuildInfoFile: string | undefined,
): void {
  if (tsBuildInfoFile !== undefined) {
    projection.projectedOutputs.delete(tsBuildInfoFile);
  }
}

function createEffectiveOptionsFingerprint(
  preparation: LeafPreparation,
): string {
  const references = preparation.parsedProof.parsed.projectReferences;
  return hashValue({
    adapterExtensions: preparation.parsed.extensions,
    compilerOptions: preparation.parsed.options,
    projectReferences: references?.map((reference) =>
      normalizeAbsolutePath(reference.path),
    ),
  });
}

function createBuildStateProof(options: {
  classification: ManagedLeafClassification;
  outputPaths: string[];
  tsBuildInfoFile: string | undefined;
}): ManagedLeafMutationProof['buildStateProof'] {
  if (options.classification.kind !== 'user-output') {
    return { outputPaths: [] };
  }
  if (options.tsBuildInfoFile === undefined) {
    return { outputPaths: options.outputPaths };
  }
  return {
    outputPaths: options.outputPaths,
    tsBuildInfoPath: options.tsBuildInfoFile,
  };
}

function createLeafResult(options: {
  classification: ManagedLeafClassification;
  mutationTargets: MutationBoundaryTarget[];
  outputPaths: string[];
  preparation: LeafPreparation;
  projection: ManagedOutputProjection;
  tsBuildInfoFile: string | undefined;
}): ManagedLeafMutationProof {
  return {
    buildStateProof: createBuildStateProof({
      classification: options.classification,
      outputPaths: options.outputPaths,
      tsBuildInfoFile: options.tsBuildInfoFile,
    }),
    configDependencies: [...options.preparation.parsedProof.configDependencies],
    effectiveOptionsFingerprint: createEffectiveOptionsFingerprint(
      options.preparation,
    ),
    inputPaths: options.preparation.parsed.fileNames
      .map(normalizeAbsolutePath)
      .sort(),
    mutationTargets: options.mutationTargets,
    projectedOutputPaths: [...options.projection.projectedOutputs].sort(),
  };
}

export async function proveLeafMutation(options: {
  artifactNamespace: LiminaArtifactNamespace;
  checker: ResolvedCheckerConfig;
  classification: ManagedLeafClassification;
  configPath: string;
  projectRootDir: string;
  workspaceContext: ValidatedWorkspaceContext;
}): Promise<ManagedLeafMutationProof> {
  const preparation = prepareLeafProject(options);
  const outDir = getEffectiveOutDir(
    options.configPath,
    preparation.parsed.options,
  );
  const outputAuthority = await getOutputAuthority({
    artifactNamespace: options.artifactNamespace,
    classification: options.classification,
    outDir,
    workspaceContext: options.workspaceContext,
  });
  const projection = collectProjectedOutputs({
    adapterExtensions: preparation.parsed.extensions,
    compilerOptions: preparation.parsed.options,
    configPath: options.configPath,
    emitProjection: preparation.adapter.emitProjection,
    fileNames: preparation.parsed.fileNames,
    projectReferences: preparation.parsedProof.parsed.projectReferences,
  });
  const tsBuildInfoFile = getBuildInfoFile(preparation.parsed);
  removeBuildInfoFromProjection(projection, tsBuildInfoFile);
  assertProjectionInside({
    configPath: options.configPath,
    outDir,
    projection,
  });
  const outputPaths = [...projection.projectedOutputs].sort();
  const mutationTargets: MutationBoundaryTarget[] = [];
  addOutputMutationTargets({
    authority: outputAuthority,
    outDir,
    outputPaths,
    targets: mutationTargets,
    usesBoundedVueDirectory: projection.usesBoundedVueDirectory,
  });
  await addBuildInfoTarget({
    artifactNamespace: options.artifactNamespace,
    classification: options.classification,
    projectedOutputs: projection.projectedOutputs,
    targets: mutationTargets,
    tsBuildInfoFile,
  });
  return createLeafResult({
    classification: options.classification,
    mutationTargets,
    outputPaths,
    preparation,
    projection,
    tsBuildInfoFile,
  });
}
