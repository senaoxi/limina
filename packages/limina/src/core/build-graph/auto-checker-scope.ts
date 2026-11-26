import type { CheckerName, ResolvedLiminaInputs } from '#config/runner';
import type { JsonObject } from '#core/tsconfig/actions';
import { compareCodeUnits } from '#utils/collections';
import path from 'pathe';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import { readSolutionRoleFileNames } from './auto-checker-project';
import type { SourceConfigCandidate } from './auto-checker-types';
import { inspectFrameworkIntent } from './framework-intent';
import type { AutoFrameworkEvidence } from './source-capabilities';
import { collectCheckerSourceConfigs } from './source-config-collection';
import type { AutoScope } from './types';

function isRoleProbeNeeded(
  configPath: string,
  configObject: JsonObject,
): boolean {
  return (
    path.basename(configPath) === 'tsconfig.json' &&
    Object.hasOwn(configObject, 'references') &&
    !(Array.isArray(configObject.files) && configObject.files.length > 0)
  );
}

export function collectOwnershipScope(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  checkerName?: CheckerName;
  config: ResolvedLiminaInputs;
  entryConfigPath: string;
  explicitOwnerByConfigPath: ReadonlyMap<string, CheckerName>;
  onInputError?: (configPath: string, error: Error) => void;
  onProblems?: (problems: string[]) => void;
}): AutoScope {
  const candidates = new Map<string, SourceConfigCandidate>();
  const frameworkEvidence: AutoFrameworkEvidence[] = [];
  const collection = collectCheckerSourceConfigs({
    ...options,
    checkerName: options.checkerName ?? 'tsc',
    entryConfigPaths: [options.entryConfigPath],
    sourceConfigParser: (configPath, _referencedFrom, configObject) => {
      candidates.set(configPath, {
        configObject,
        configPath,
        packageRootDir:
          options.activatedRegions.findPackageForPath(configPath)!.directory,
      });
      if (options.checkerName === undefined)
        frameworkEvidence.push({
          configPath,
          intentHints: inspectFrameworkIntent({ configPath, configObject }),
        });
      if (!isRoleProbeNeeded(configPath, configObject)) return {};
      const checkerName =
        options.checkerName ??
        options.explicitOwnerByConfigPath.get(configPath);
      return {
        fileNames: readSolutionRoleFileNames({
          ...options,
          configPath,
          checkerName,
        }),
      };
    },
  });
  return {
    authoritativeChecker: options.checkerName,
    candidates: [...collection.projectConfigPaths]
      .sort(compareCodeUnits)
      .map((configPath) => candidates.get(configPath)!),
    collection,
    entryConfigPath: options.entryConfigPath,
    frameworkEvidence,
  };
}
