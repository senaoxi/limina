import { LiminaStructuredError } from 'limina/internal/check-reporting/errors';
import { TypeScriptConfigInputError } from 'limina/internal/checker/project-base';
import type { ResolvedLiminaConfig } from 'limina/internal/config/runner';
import { isOrdinarySourceTypecheckConfigPath } from 'limina/internal/core/tsconfig/actions';
import { TsconfigInputError } from 'limina/internal/core/tsconfig/config-paths';
import { collectRawWorkspacePackages } from 'limina/internal/core/workspace/actions';
import {
  collectValidatedWorkspaceContext,
  collectWorkspaceInputSnapshot,
} from 'limina/internal/core/workspace/validated-context';
import { resolveStableDescriptors } from 'limina/internal/core/workspace/validated/descriptors/stability';
import { excludeTsconfigDescriptors } from 'limina/internal/core/workspace/validated/exclusions';
import { collectOutputDeclarations } from 'limina/internal/core/workspace/validated/outputs/collection';
import { MigrationInputError } from './declarations';

function isReadableIoFailure(error: Error): boolean {
  return (
    'code' in error &&
    ['EACCES', 'EPERM', 'ENOENT', 'EISDIR'].includes(String(error.code))
  );
}
export function isExpectedInputFailure(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  const isKnown = [
    MigrationInputError,
    TypeScriptConfigInputError,
    TsconfigInputError,
  ].some((Type) => error instanceof Type);
  return isKnown || isReadableIoFailure(error);
}

function assertRecoverableOutputFailure(error: unknown): void {
  if (!(error instanceof LiminaStructuredError)) throw error;
  if (
    error.issues.some(
      (issue) =>
        ![
          'LIMINA_WORKSPACE_OUTPUT_CYCLE',
          'LIMINA_WORKSPACE_OUTPUT_ROOT_INVALID',
        ].includes(issue.code),
    )
  )
    throw error;
}

export async function discover(
  config: ResolvedLiminaConfig,
): Promise<string[]> {
  const rawPackages = await collectRawWorkspacePackages(config);
  try {
    return [
      ...(await collectValidatedWorkspaceContext({ config, rawPackages }))
        .sourceConfigPaths,
    ].filter((file) =>
      isOrdinarySourceTypecheckConfigPath(file, config.rootDir),
    );
  } catch (error) {
    assertRecoverableOutputFailure(error);
    const snapshot = await collectWorkspaceInputSnapshot({
      config,
      rawPackages,
    });
    const declarations = await collectOutputDeclarations({
      config,
      activatedPackageRoots: snapshot.activatedPackageRoots,
      universe: [],
    });
    return resolveStableDescriptors({
      config,
      explicitOutputs: new Map(),
      packageOutputs: declarations.packageOutputs,
      packageBoundaries: snapshot.islands.boundaries.filter(
        (boundary) => boundary.kind === 'package-scope',
      ),
      universe: excludeTsconfigDescriptors({
        config,
        candidates: snapshot.islands.universe,
      }),
    })
      .candidates.filter(
        (candidate) =>
          candidate.kind === 'tsconfig' &&
          isOrdinarySourceTypecheckConfigPath(candidate.path, config.rootDir),
      )
      .map((candidate) => candidate.path)
      .sort((left, right) => Number(left > right) - Number(left < right));
  }
}
