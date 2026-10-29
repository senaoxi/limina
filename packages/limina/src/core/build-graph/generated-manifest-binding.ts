import { compareCodeUnits } from '#utils/collections';
import { toPosixPath, toRelativePath } from '#utils/path';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import {
  createExecutionTargets,
  createOwnershipManifest,
} from './manifest-ownership';
import type {
  GeneratedBuildModule,
  GeneratedTsconfigGraphResult,
} from './types';

type ManifestGraph = Pick<
  GeneratedTsconfigGraphResult,
  | 'manifest'
  | 'ownershipPlan'
  | 'governedSources'
  | 'checkerEntries'
  | 'sourceToDts'
  | 'dtsToSource'
  | 'sourceToBuild'
  | 'configToOutputBuild'
>;

function projectPaths<Value, Projected>(
  values: ReadonlyMap<string, Value> | undefined,
  relative: (path: string) => string,
  project: (value: Value) => Projected,
): Record<string, Projected> {
  return Object.fromEntries(
    [...(values ?? [])].map(([key, value]) => [relative(key), project(value)]),
  );
}

/**
The serialized manifest cannot redefine the source ownership or execution maps.
*/
export function assertGeneratedManifestBinding(
  graph: ManifestGraph,
  rootDirectory: string,
): void {
  const relative = (value: string) =>
    toPosixPath(toRelativePath(rootDirectory, value));
  const module = (value: GeneratedBuildModule) => ({
    kind: value.kind,
    path: relative(value.path),
  });
  const checkers = Object.fromEntries(
    [...graph.checkerEntries].map(([name, entry]) => [
      name,
      {
        name,
        entry: relative(entry),
        roots: graph.ownershipPlan.typeConfigs
          .values()
          .filter((source) => source.finalOwner === name)
          .map((source) => relative(source.configPath))
          .toArray()
          .sort(compareCodeUnits),
        sourceToDts: projectPaths(
          graph.sourceToDts.get(name),
          relative,
          relative,
        ),
        dtsToSource: projectPaths(
          graph.dtsToSource.get(name),
          relative,
          relative,
        ),
        sourceToBuild: projectPaths(
          graph.sourceToBuild.get(name),
          relative,
          module,
        ),
        configToOutputBuild: projectPaths(
          graph.configToOutputBuild.get(name),
          relative,
          module,
        ),
      },
    ]),
  );
  const expected = {
    checkers,
    ownership: createOwnershipManifest({
      ownershipPlan: graph.ownershipPlan,
      rootDir: rootDirectory,
    }),
    targets: createExecutionTargets({
      checkers,
      rootDir: rootDirectory,
      governedSourcesByChecker: new Map(
        [...graph.governedSources].map(([checker, sources]) => [
          checker,
          sources.values().toArray(),
        ]),
      ),
    }),
  };
  for (const field of ['checkers', 'ownership', 'targets'] as const)
    if (
      nativeFingerprint(expected[field]) !==
      nativeFingerprint(graph.manifest[field])
    )
      throw new Error(
        `Manifest ${field} differ from current source and execution projections.`,
      );
}
