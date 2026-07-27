import type { ResolvedCheckerConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import ts from 'typescript';
import type { ValidatedWorkspaceContext } from '../../core/workspace/validated-context';
import type { LiminaArtifactNamespace } from '../../domain/artifacts/namespace';
import type { TypecheckTarget } from '../targets';
import { collectLeafClassifications, collectTargetLeafConfigs } from './config';
import { getCheckerImplementationFingerprint, hashValue } from './identity';
import { proveLeafMutation } from './leaf';
import {
  type ConfigDependencyIdentity,
  ManagedCheckerEmitBoundaryError,
  type ManagedLeafMutationProof,
  type ProvenManagedCheckerMutationContext,
} from './types';

function checkerForTarget(options: {
  checkers: readonly ResolvedCheckerConfig[];
  target: TypecheckTarget;
}): ResolvedCheckerConfig {
  const checker = options.checkers.find(
    (candidate) => candidate.name === options.target.checkerName,
  );
  if (checker !== undefined) return checker;
  throw new ManagedCheckerEmitBoundaryError(
    `Unable to resolve checker for managed target ${options.target.id}.`,
  );
}

function createFingerprint(options: {
  checker: ResolvedCheckerConfig;
  checkerImplementationFingerprint: string;
  configDependencies: readonly ConfigDependencyIdentity[];
  effectiveOptionsFingerprint: string;
  inputPaths: readonly string[];
  leafConfigPaths: readonly string[];
  projectedOutputPaths: readonly string[];
  target: TypecheckTarget;
  workspaceContext: ValidatedWorkspaceContext;
}): string {
  return hashValue({
    checker: {
      implementation: options.checkerImplementationFingerprint,
      name: options.checker.name,
      preset: options.checker.preset,
      typescriptVersion: ts.version,
    },
    configDependencies: options.configDependencies,
    effectiveOptionsFingerprint: options.effectiveOptionsFingerprint,
    inputPaths: options.inputPaths,
    leafConfigPaths: options.leafConfigPaths,
    projectedOutputPaths: options.projectedOutputPaths,
    target: {
      configPath: options.target.configPath,
      id: options.target.id,
      sourceConfigPath: options.target.sourceConfigPath,
    },
    workspaceGeneration: options.workspaceContext.workspaceMutationGeneration,
  });
}

function createEmptyProof(options: {
  checker: ResolvedCheckerConfig;
  checkerImplementationFingerprint: string;
  dependencies: ConfigDependencyIdentity[];
  target: TypecheckTarget;
  workspaceContext: ValidatedWorkspaceContext;
}): ProvenManagedCheckerMutationContext {
  const effectiveOptionsFingerprint = hashValue([]);
  return {
    buildStateProofs: [],
    checkerImplementationFingerprint: options.checkerImplementationFingerprint,
    configDependencies: options.dependencies,
    effectiveOptionsFingerprint,
    fingerprint: createFingerprint({
      checker: options.checker,
      checkerImplementationFingerprint:
        options.checkerImplementationFingerprint,
      configDependencies: options.dependencies,
      effectiveOptionsFingerprint,
      inputPaths: [],
      leafConfigPaths: [],
      projectedOutputPaths: [],
      target: options.target,
      workspaceContext: options.workspaceContext,
    }),
    inputPaths: [],
    leafConfigPaths: [],
    mutationTargets: [],
    projectedOutputPaths: [],
    targetId: options.target.id,
  };
}

function mergeDependencies(options: {
  closureDependencies: readonly ConfigDependencyIdentity[];
  leafProofs: readonly ManagedLeafMutationProof[];
}): ConfigDependencyIdentity[] {
  const dependencies = new Map<string, ConfigDependencyIdentity>(
    options.closureDependencies.map((dependency) => [
      dependency.path,
      dependency,
    ]),
  );
  for (const leaf of options.leafProofs) {
    for (const dependency of leaf.configDependencies) {
      dependencies.set(dependency.path, dependency);
    }
  }
  return [...dependencies.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

function collectUniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function createCombinedProof(options: {
  checker: ResolvedCheckerConfig;
  checkerImplementationFingerprint: string;
  closureDependencies: readonly ConfigDependencyIdentity[];
  leafConfigPaths: string[];
  leafProofs: readonly ManagedLeafMutationProof[];
  target: TypecheckTarget;
  workspaceContext: ValidatedWorkspaceContext;
}): ProvenManagedCheckerMutationContext {
  const configDependencies = mergeDependencies(options);
  const inputPaths = collectUniqueSorted(
    options.leafProofs.flatMap((leaf) => leaf.inputPaths),
  );
  const projectedOutputPaths = collectUniqueSorted(
    options.leafProofs.flatMap((leaf) => leaf.projectedOutputPaths),
  );
  const effectiveOptionsFingerprint = hashValue(
    options.leafProofs.map((leaf) => leaf.effectiveOptionsFingerprint).sort(),
  );
  return {
    buildStateProofs: options.leafProofs.map((leaf) => leaf.buildStateProof),
    checkerImplementationFingerprint: options.checkerImplementationFingerprint,
    configDependencies,
    effectiveOptionsFingerprint,
    fingerprint: createFingerprint({
      checker: options.checker,
      checkerImplementationFingerprint:
        options.checkerImplementationFingerprint,
      configDependencies,
      effectiveOptionsFingerprint,
      inputPaths,
      leafConfigPaths: options.leafConfigPaths,
      projectedOutputPaths,
      target: options.target,
      workspaceContext: options.workspaceContext,
    }),
    inputPaths,
    leafConfigPaths: options.leafConfigPaths,
    mutationTargets: options.leafProofs.flatMap((leaf) => leaf.mutationTargets),
    projectedOutputPaths,
    targetId: options.target.id,
  };
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
  const checker = checkerForTarget(options);
  const checkerImplementationFingerprint = getCheckerImplementationFingerprint({
    checker,
    projectRootDir: options.projectRootDir,
    target: options.target,
  });
  if (closure.leafPaths.length === 0) {
    return createEmptyProof({
      checker,
      checkerImplementationFingerprint,
      dependencies: closure.dependencies,
      target: options.target,
      workspaceContext: options.workspaceContext,
    });
  }
  const leafProofs = await Promise.all(
    closure.leafPaths.map(async (configPath) => {
      const classification = classifications.get(configPath);
      if (classification === undefined) {
        throw new ManagedCheckerEmitBoundaryError(
          `Managed checker leaf classification disappeared: ${configPath}.`,
        );
      }
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
  return createCombinedProof({
    checker,
    checkerImplementationFingerprint,
    closureDependencies: closure.dependencies,
    leafConfigPaths: closure.leafPaths,
    leafProofs,
    target: options.target,
    workspaceContext: options.workspaceContext,
  });
}
