import type { ResolvedLiminaInputs } from '#config/runner';
import { collectRawWorkspacePackages } from '#core/workspace/actions';
import {
  observeAnalysisRead,
  withoutAnalysisReads,
} from '#utils/analysis-input';
import { compareCodeUnits } from '#utils/collections';
import { packageManifestState } from '../analysis-cache/directory-fingerprint';
import {
  collectValidatedWorkspaceContext,
  type ValidatedWorkspaceContext,
} from '../workspace/validated-context';
import { descriptorStamp } from '../workspace/validated/descriptor-stamp';

export async function getBuildGraphWorkspace(options: {
  config: ResolvedLiminaInputs;
  workspaceContext?: ValidatedWorkspaceContext;
}): Promise<ValidatedWorkspaceContext> {
  const context =
    options.workspaceContext ??
    (await collectValidatedWorkspaceContext({
      config: options.config,
      rawPackages: await collectRawWorkspacePackages(options.config),
    }));
  const topology = manifestTopology(context);
  observeAnalysisRead({
    key: JSON.stringify(['region-package-scopes', options.config.rootDir]),
    path: options.config.rootDir,
    workspaceTopology: true,
    value: topology,
    read: () => {
      if (
        context.descriptorStamps !== undefined &&
        [...context.descriptorStamps].every(
          ([file, stamp]) =>
            stamp !== undefined && descriptorStamp(file) === stamp,
        )
      )
        return topology;
      return withoutAnalysisReads(async () =>
        manifestTopology(
          await collectValidatedWorkspaceContext({
            config: options.config,
            rawPackages: await collectRawWorkspacePackages(options.config),
          }),
        ),
      );
    },
  });
  return context;
}

function manifestTopology(context: ValidatedWorkspaceContext): string[] {
  return [
    ...context.packages.map((package_) =>
      JSON.stringify(['active', package_.directory]),
    ),
    ...context.extendedPackageScopes.map((scope) =>
      JSON.stringify(['extended', scope.rootDir, scope.ownerDirectory]),
    ),
    ...context.boundaries.map((boundary) =>
      JSON.stringify([boundary.kind, boundary.rootDir]),
    ),
    ...context.descriptorCandidates
      .filter((candidate) => candidate.kind === 'package-json')
      .map((candidate) =>
        JSON.stringify([
          candidate.path,
          candidate.canonicalPath,
          packageManifestState(candidate.path),
        ]),
      ),
  ].sort(compareCodeUnits);
}
