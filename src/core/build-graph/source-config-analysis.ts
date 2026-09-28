import {
  normalizeExtensions,
  parseCheckerProjectConfigForContext,
} from '#checkers';
import { readJsonConfig } from '#core/tsconfig/actions';
import { capabilityDiscoveryExtensions } from './generated/file-extensions';
import type {
  ConfigVisit,
  SourceConfigAnalysis,
} from './source-config-collection-types';

function resolveDiscoveryExtensions(options: ConfigVisit): string[] {
  if (options.discoveryExtensions) return options.discoveryExtensions;
  return normalizeExtensions(capabilityDiscoveryExtensions);
}

function inspectionAddedProblems(options: {
  configObject: SourceConfigAnalysis['configObject'];
  problemCount: number;
  visit: ConfigVisit;
}): boolean {
  if (!options.visit.sourceConfigInspector) return false;
  options.visit.sourceConfigInspector({
    configObject: options.configObject,
    sourceConfigPath: options.visit.sourceConfigPath,
  });
  return options.visit.problems.length > options.problemCount;
}

export function parseSourceConfig(
  options: ConfigVisit,
): SourceConfigAnalysis | null {
  const configObject = readJsonConfig(options.config, options.sourceConfigPath);
  if (
    inspectionAddedProblems({
      configObject,
      problemCount: options.problems.length,
      visit: options,
    })
  ) {
    return null;
  }
  const parsed = parseCheckerProjectConfigForContext({
    allowNoInputDiagnostics: true,
    cache: options.projectConfigCache,
    configPath: options.sourceConfigPath,
    context: {
      checkerPresets: [options.checkerPreset],
      extensions: resolveDiscoveryExtensions(options),
    },
    projectRootDir: options.config.rootDir,
  });
  return {
    configObject,
    fileNames: parsed.fileNames,
    options: parsed.options,
  };
}
