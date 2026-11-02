import type {
  ResolvedCheckerConfig,
  ResolvedLiminaInputs,
} from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { readFile } from 'node:fs/promises';
import path from 'pathe';
import type { LiminaArtifactNamespace } from '../../domain/artifacts/namespace';
import { createRevisionedArtifactPlan } from '../../domain/artifacts/plan';
import {
  createOwnedArtifactLedger,
  removeStaleGeneratedFiles,
} from './artifact-ledger';
import { writeGeneratedContent, writeGeneratedJson } from './artifact-writer';
import type { prepareGeneratedKnipPackageConfigs } from './generated-knip';
import { generatedManifestPath } from './generated/paths';
import { createManifest } from './manifest';
import { generatedGraphManifestVersion } from './manifest-version';
import {
  materializationLedgerRelativePath,
  readMaterializationStateSnapshot,
} from './materialization-state';
import type { GeneratedGraphPreparationState } from './prepare-state';
import { createResult } from './result';
import { planScopedCheckArtifacts } from './scoped-check-artifacts';
import type { PreparedTsconfigGraph } from './types';

type GeneratedKnipPreparation = ReturnType<
  typeof prepareGeneratedKnipPackageConfigs
>;

function getManifestPath(config: ResolvedLiminaInputs): string {
  return normalizeAbsolutePath(
    path.join(config.rootDir, generatedManifestPath),
  );
}

export async function finalizeGeneratedGraph(options: {
  artifactNamespace: LiminaArtifactNamespace;
  checkers: ResolvedCheckerConfig[];
  config: ResolvedLiminaInputs;
  generatedKnip: GeneratedKnipPreparation;
  state: GeneratedGraphPreparationState;
}): Promise<PreparedTsconfigGraph> {
  const auxiliaryArtifacts = await planScopedCheckArtifacts(
    options.state,
    options.artifactNamespace,
  );
  const manifestPath =
    options.state.purpose === 'producer-build'
      ? normalizeAbsolutePath(
          path.join(
            options.artifactNamespace.rootDir,
            'producer-manifest.json',
          ),
        )
      : getManifestPath(options.config);
  const manifest = createManifest({
    purpose: options.state.purpose,
    checkerEntries: options.state.checkerEntries,
    checkers: options.checkers,
    configToOutputBuildByChecker: options.state.configToOutputBuildByChecker,
    generatedKnipDiagnostics: options.generatedKnip.diagnostics,
    generatedKnipPackageConfigs: options.generatedKnip.configs.map(
      (entry) => entry.config,
    ),
    governedSourcesByChecker: options.state.governedSourcesByChecker,
    ownedArtifacts: createOwnedArtifactLedger({
      artifactNamespace: options.artifactNamespace,
      expectedFiles: options.state.writeContext.expectedFiles,
      manifestPath,
    }),
    ownershipPlan: options.state.checkerOwnershipPlan,
    projectsByChecker: options.state.projectsByChecker,
    dependencyEdges: options.state.dependencyEdges,
    rootDir: options.config.rootDir,
    sourceToBuildByChecker: options.state.sourceToBuildByChecker,
  });
  if (options.state.svelteConsumerView !== undefined)
    manifest.declarationBindings = options.state.svelteConsumerView.bindings
      .values()
      .map((binding) => ({
        sourceConfig: path.relative(
          options.config.rootDir,
          binding.sourceConfig,
        ),
        sourceFile: path.relative(options.config.rootDir, binding.sourceFile),
        outputFile: path.relative(options.config.rootDir, binding.outputFile),
        mirrorFile: path.relative(options.config.rootDir, binding.mirrorFile),
        contentIdentity: binding.contentIdentity,
        receipt: options.state.svelteConsumerView!.receipt.identity,
      }))
      .toArray();
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
  const ledgerPath = normalizeAbsolutePath(
    path.join(
      options.artifactNamespace.rootDir,
      materializationLedgerRelativePath,
    ),
  );
  options.state.writeContext.expectedFiles.add(ledgerPath);
  if (options.state.purpose === 'producer-build') {
    // A partial preparation may update its files, never retire another phase's files.
    for (const file of previousOwnedPaths) {
      if (
        options.state.writeContext.expectedFiles.has(file) ||
        file ===
          path.join(
            options.artifactNamespace.rootDir,
            materializationLedgerRelativePath,
          )
      )
        continue;
      try {
        await writeGeneratedContent({
          context: options.state.writeContext,
          filePath: file,
          content: await readFile(file, 'utf8'),
        });
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          )
        )
          throw error;
      }
    }
  } else
    await removeStaleGeneratedFiles({
      context: options.state.writeContext,
      previousOwnedPaths,
    });
  // Mutation ownership is independent from publication of a complete graph.
  await writeGeneratedJson({
    context: options.state.writeContext,
    filePath: ledgerPath,
    value: {
      version: generatedGraphManifestVersion,
      generatedBy: 'limina',
      ownedArtifacts: [...options.state.writeContext.expectedFiles]
        .map((file) => path.relative(options.artifactNamespace.rootDir, file))
        .sort(compareCodeUnits),
    },
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
  const result = createResult({
    purpose: options.state.purpose,
    artifactPlan,
    changed: options.state.writeContext.changed,
    checkers: options.checkers,
    generatedFiles: options.state.writeContext.files,
    governedSourcesByChecker: options.state.governedSourcesByChecker,
    manifest,
    manifestPath,
    outputDeclarationCopiesByChecker:
      options.state.outputDeclarationCopiesByChecker,
    ownershipPlan: options.state.checkerOwnershipPlan,
    rootDir: options.config.rootDir,
  });
  return {
    ...result,
    auxiliaryArtifacts,
    outputProjections: options.state.projectsByChecker
      .values()
      .flatMap((projects) =>
        projects.flatMap((project) => project.outputProjections ?? []),
      )
      .toArray(),
    typeInputProjections: options.state.projectsByChecker
      .values()
      .flatMap((projects) =>
        projects.flatMap((project) => project.typeInputProjections ?? []),
      )
      .toArray(),
    libraryProjections: options.state.projectsByChecker
      .values()
      .flatMap((projects) =>
        projects.flatMap((project) => project.libraryProjections ?? []),
      )
      .toArray(),
  };
}
