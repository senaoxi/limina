import type { ResolvedLiminaConfig } from '#config/runner';
import { collectRawWorkspacePackages } from '#core/workspace/actions';
import { LiminaStructuredError } from '../../check-reporting/errors';
import { TypeScriptConfigInputError } from '../../checker/project-base';
import { TsconfigInputError } from '../../core/tsconfig/config-paths';
import {
  collectValidatedWorkspaceContext,
  collectWorkspaceInputSnapshot,
} from '../../core/workspace/validated-context';
import { resolveStableDescriptors } from '../../core/workspace/validated/descriptors/stability';
import { excludeTsconfigDescriptors } from '../../core/workspace/validated/exclusions';
import { collectOutputDeclarations } from '../../core/workspace/validated/outputs/collection';
import { MigrationInputError } from './declarations';

function isReadableIoFailure(error: Error): boolean {
  if (!('code' in error)) return false;
  return ['EACCES', 'EPERM', 'ENOENT', 'EISDIR'].includes(String(error.code));
}
export function expectedInputFailure(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  const known = [
    MigrationInputError,
    TypeScriptConfigInputError,
    TsconfigInputError,
  ].some((Type) => error instanceof Type);
  return known || isReadableIoFailure(error);
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
    ];
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
      .candidates.filter((candidate) => candidate.kind === 'tsconfig')
      .map((candidate) => candidate.path)
      .sort();
  }
}
