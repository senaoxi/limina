import type {
  ResolvedCheckerConfig,
  ResolvedLiminaConfig,
} from '#config/runner';
import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import type { LiminaArtifactNamespace } from '../../domain/artifacts/namespace';
import { createRevisionedArtifactPlan } from '../../domain/artifacts/plan';
import {
  createOwnedArtifactLedger,
  removeStaleGeneratedFiles,
} from './artifact-ledger';
import { writeGeneratedJson } from './artifact-writer';
import type { prepareGeneratedKnipPackageConfigs } from './generated-knip';
import { generatedManifestPath } from './generated/paths';
import { createManifest } from './manifest';
import { readMaterializationStateSnapshot } from './materialization-state';
import type { GeneratedGraphPreparationState } from './prepare-state';
import { createResult } from './result';
import type { GeneratedTsconfigGraphResult } from './types';

type GeneratedKnipPreparation = ReturnType<
  typeof prepareGeneratedKnipPackageConfigs
>;

function getManifestPath(config: ResolvedLiminaConfig): string {
  return normalizeAbsolutePath(
    path.join(config.rootDir, generatedManifestPath),
  );
}

export async function finalizeGeneratedGraph(options: {
  artifactNamespace: LiminaArtifactNamespace;
  checkers: ResolvedCheckerConfig[];
  config: ResolvedLiminaConfig;
  generatedKnip: GeneratedKnipPreparation;
  state: GeneratedGraphPreparationState;
}): Promise<GeneratedTsconfigGraphResult> {
  const manifestPath = getManifestPath(options.config);
  const manifest = createManifest({
    checkerEntries: options.state.checkerEntries,
    checkers: options.checkers,
    configToOutputBuildByChecker: options.state.configToOutputBuildByChecker,
    generatedKnipDiagnostics: options.generatedKnip.diagnostics,
    generatedKnipPackageConfigs: options.generatedKnip.configs.map(
      (entry) => entry.config,
    ),
    ownedArtifacts: createOwnedArtifactLedger({
      artifactNamespace: options.artifactNamespace,
      expectedFiles: options.state.writeContext.expectedFiles,
      manifestPath,
    }),
    projectsByChecker: options.state.projectsByChecker,
    providerEdges: options.state.providerEdges,
    rootDir: options.config.rootDir,
    sourceToBuildByChecker: options.state.sourceToBuildByChecker,
  });
  const baseState = await readMaterializationStateSnapshot(
    options.artifactNamespace,
  );
  const previousOwnedPaths = baseState.ownedPaths.map((relativePath) =>
    normalizeAbsolutePath(
      path.join(options.artifactNamespace.rootDir, relativePath),
    ),
  );
  await writeGeneratedJson({
    context: options.state.writeContext,
    filePath: manifestPath,
    value: manifest,
  });
  await removeStaleGeneratedFiles({
    context: options.state.writeContext,
    previousOwnedPaths,
  });
  const artifactPlan = createRevisionedArtifactPlan(
    options.artifactNamespace,
    options.state.writeContext.changes,
    {
      baseOwnedPaths: previousOwnedPaths,
      baseRevision: baseState.revision,
      ownedPaths: [...options.state.writeContext.expectedFiles],
    },
  );
  return createResult({
    artifactPlan,
    changed: options.state.writeContext.changed,
    checkers: options.checkers,
    generatedFiles: options.state.writeContext.files,
    manifest,
    manifestPath,
    outputDeclarationCopiesByChecker:
      options.state.outputDeclarationCopiesByChecker,
    rootDir: options.config.rootDir,
  });
}
