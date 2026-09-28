import type {
  GeneratedTsconfigGraphResult,
  GovernedSourceUnit,
} from '#core/build-graph/runner';

export function getGeneratedCheckerNamespace(
  configPath: string,
): string | null {
  const marker = '/.limina/tsconfig/checkers/';
  const markerIndex = configPath.indexOf(marker);

  if (markerIndex === -1) {
    return null;
  }

  const rest = configPath.slice(markerIndex + marker.length);
  const separatorIndex = rest.indexOf('/');

  return separatorIndex === -1 ? null : rest.slice(0, separatorIndex);
}

export function isSameGeneratedCheckerNamespace(
  leftConfigPath: string,
  rightConfigPath: string,
): boolean {
  const leftChecker = getGeneratedCheckerNamespace(leftConfigPath);
  const rightChecker = getGeneratedCheckerNamespace(rightConfigPath);

  if (!leftChecker) {
    return true;
  }

  if (!rightChecker) {
    return true;
  }

  return leftChecker === rightChecker;
}

export function getGeneratedSourceConfigPath(
  generatedGraph: GeneratedTsconfigGraphResult,
  projectPath: string,
): string | undefined {
  for (const dtsToSource of generatedGraph.dtsToSource.values()) {
    const sourceConfigPath = dtsToSource.get(projectPath);

    if (sourceConfigPath) {
      return sourceConfigPath;
    }
  }

  return undefined;
}

function getCheckerTargetPath(options: {
  checkerName: string;
  generatedGraph: GeneratedTsconfigGraphResult;
  sourceConfigPath: string;
}): string | undefined {
  return options.generatedGraph.sourceToDts
    .get(options.checkerName)
    ?.get(options.sourceConfigPath);
}

function getTargetPathOrFallback(
  targetPath: string | undefined,
  fallbackPath: string,
): string {
  return targetPath ?? fallbackPath;
}

export function getPreferredGeneratedTargetProjectPath(options: {
  generatedGraph: GeneratedTsconfigGraphResult;
  importingProjectPath: string;
  targetProjectPath: string;
}): string {
  const checkerName = getGeneratedCheckerNamespace(
    options.importingProjectPath,
  );
  if (!checkerName) {
    return options.targetProjectPath;
  }

  const sourceConfigPath = getGeneratedSourceConfigPath(
    options.generatedGraph,
    options.targetProjectPath,
  );
  if (!sourceConfigPath) {
    return options.targetProjectPath;
  }

  return getTargetPathOrFallback(
    getCheckerTargetPath({
      checkerName,
      generatedGraph: options.generatedGraph,
      sourceConfigPath,
    }),
    options.targetProjectPath,
  );
}

export function createGeneratedProjectCheckerNamesByPath(
  generatedGraph: GeneratedTsconfigGraphResult,
): Map<string, string> {
  const checkerNamesByPath = new Map<string, string>();

  addGovernedProjectCheckerNames(generatedGraph, checkerNamesByPath);
  addDeclarationProjectCheckerNames(generatedGraph, checkerNamesByPath);

  return checkerNamesByPath;
}

function addGovernedProjectCheckerNames(
  generatedGraph: GeneratedTsconfigGraphResult,
  checkerNamesByPath: Map<string, string>,
): void {
  for (const [checkerName, governedSources] of generatedGraph.governedSources) {
    addGovernedCheckerProjectNames({
      checkerName,
      checkerNamesByPath,
      governedSources,
    });
  }
}

function addGovernedCheckerProjectNames(options: {
  checkerName: string;
  checkerNamesByPath: Map<string, string>;
  governedSources: ReadonlyMap<string, GovernedSourceUnit>;
}): void {
  for (const unit of options.governedSources.values()) {
    options.checkerNamesByPath.set(unit.configPath, options.checkerName);
    addGovernedProjectionCheckerName({ ...options, unit });
  }
}

function addGovernedProjectionCheckerName(options: {
  checkerName: string;
  checkerNamesByPath: Map<string, string>;
  unit: GovernedSourceUnit;
}): void {
  if (options.unit.buildProjection.kind === 'framework-checker') return;
  options.checkerNamesByPath.set(
    'buildConfigPath' in options.unit.buildProjection
      ? options.unit.buildProjection.buildConfigPath
      : options.unit.buildProjection.dtsConfigPath,
    options.checkerName,
  );
}

function addDeclarationProjectCheckerNames(
  generatedGraph: GeneratedTsconfigGraphResult,
  checkerNamesByPath: Map<string, string>,
): void {
  for (const [checkerName, sourceToDts] of generatedGraph.sourceToDts) {
    for (const dtsConfigPath of sourceToDts.values()) {
      checkerNamesByPath.set(dtsConfigPath, checkerName);
    }
  }
}
