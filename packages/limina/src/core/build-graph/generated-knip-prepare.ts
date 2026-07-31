import type {
  ResolvedCheckerConfig,
  ResolvedLiminaConfig,
} from '#config/runner';
import type { GeneratedBuildModule } from '#core/build-graph/runner';
import {
  isNamedWorkspacePackage,
  type WorkspacePackage,
} from '#core/workspace/actions';
import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import {
  collectPackageBuildScripts,
  type PackageBuildScript,
} from '../packages/build-scripts';
import {
  createGeneratedKnipContent,
  getGeneratedKnipConfigPath,
  toManifestRelativeDiagnostic,
  toManifestRelativePackageConfig,
} from './generated-knip-paths';
import {
  prepareKnipBuildScript,
  toPackageScriptDiagnostic,
} from './generated-knip-scripts';
import type {
  GeneratedKnipPackageBuildScript,
  GeneratedKnipPackageConfig,
  GeneratedKnipPackageDiagnostic,
  PreparedGeneratedKnipPackageConfig,
  PreparedGeneratedKnipPackageConfigs,
} from './generated-knip-types';

type NamedWorkspacePackage = WorkspacePackage & { name: string };

interface PrepareContext {
  checkers: ResolvedCheckerConfig[];
  config: ResolvedLiminaConfig;
  configToOutputBuildByChecker: Map<string, Map<string, GeneratedBuildModule>>;
  diagnostics: GeneratedKnipPackageDiagnostic[];
  scriptsByPackageName: ReadonlyMap<string, readonly PackageBuildScript[]>;
}

interface PackageScriptState {
  references: Set<string>;
  scripts: GeneratedKnipPackageBuildScript[];
}

function appendPackageScript(
  scriptsByPackageName: Map<string, PackageBuildScript[]>,
  script: PackageBuildScript,
): void {
  const existing = scriptsByPackageName.get(script.packageName);

  if (existing === undefined) {
    scriptsByPackageName.set(script.packageName, [script]);
    return;
  }

  existing.push(script);
}

function groupScriptsByPackageName(
  scripts: readonly PackageBuildScript[],
): Map<string, PackageBuildScript[]> {
  const scriptsByPackageName = new Map<string, PackageBuildScript[]>();

  for (const script of scripts) {
    appendPackageScript(scriptsByPackageName, script);
  }

  return scriptsByPackageName;
}

function getPackageScripts(
  context: PrepareContext,
  workspacePackage: NamedWorkspacePackage,
): readonly PackageBuildScript[] {
  const scripts = context.scriptsByPackageName.get(workspacePackage.name);
  return scripts === undefined ? [] : scripts;
}

function addPreparedScript(
  state: PackageScriptState,
  prepared: ReturnType<typeof prepareKnipBuildScript>,
  diagnostics: GeneratedKnipPackageDiagnostic[],
): void {
  if ('reason' in prepared) {
    diagnostics.push(prepared);
    return;
  }

  for (const reference of prepared.references) {
    state.references.add(reference);
  }
  state.scripts.push(prepared.script);
}

function collectPackageScriptState(
  workspacePackage: NamedWorkspacePackage,
  context: PrepareContext,
): PackageScriptState {
  const state: PackageScriptState = {
    references: new Set(),
    scripts: [],
  };

  for (const script of getPackageScripts(context, workspacePackage)) {
    addPreparedScript(
      state,
      prepareKnipBuildScript({
        checkers: context.checkers,
        config: context.config,
        configToOutputBuildByChecker: context.configToOutputBuildByChecker,
        script,
        workspacePackage,
      }),
      context.diagnostics,
    );
  }

  return state;
}

function createPackageConfig(
  workspacePackage: NamedWorkspacePackage,
  state: PackageScriptState,
  context: PrepareContext,
): GeneratedKnipPackageConfig {
  const configPath = getGeneratedKnipConfigPath({
    packageDirectory: workspacePackage.directory,
    rootDir: context.config.rootDir,
  });
  return {
    configPath,
    packageDirectory: workspacePackage.directory,
    packageJsonPath: normalizeAbsolutePath(
      path.join(workspacePackage.directory, 'package.json'),
    ),
    packageName: workspacePackage.name,
    references: [...state.references].sort(compareCodeUnits),
    scripts: state.scripts.sort((left, right) =>
      compareCodeUnits(left.name, right.name),
    ),
  };
}

function preparePackageConfig(
  workspacePackage: NamedWorkspacePackage,
  context: PrepareContext,
): PreparedGeneratedKnipPackageConfig | null {
  const state = collectPackageScriptState(workspacePackage, context);

  if (state.references.size === 0) {
    return null;
  }

  const config = createPackageConfig(workspacePackage, state, context);
  return {
    config: toManifestRelativePackageConfig({
      config,
      rootDir: context.config.rootDir,
    }),
    configPath: config.configPath,
    content: createGeneratedKnipContent({
      configPath: config.configPath,
      references: config.references,
    }),
  };
}

function getDiagnosticScriptName(
  diagnostic: GeneratedKnipPackageDiagnostic,
): string {
  return diagnostic.scriptName === undefined ? '' : diagnostic.scriptName;
}

function compareDiagnostics(
  left: GeneratedKnipPackageDiagnostic,
  right: GeneratedKnipPackageDiagnostic,
): number {
  const pathOrder = compareCodeUnits(
    left.packageJsonPath,
    right.packageJsonPath,
  );

  if (pathOrder !== 0) {
    return pathOrder;
  }

  return compareCodeUnits(
    getDiagnosticScriptName(left),
    getDiagnosticScriptName(right),
  );
}

function createPrepareContext(options: {
  checkers: ResolvedCheckerConfig[];
  config: ResolvedLiminaConfig;
  configToOutputBuildByChecker: Map<string, Map<string, GeneratedBuildModule>>;
  workspacePackages: WorkspacePackage[];
}): PrepareContext {
  const packageBuildScripts = collectPackageBuildScripts({
    config: options.config,
    workspacePackages: options.workspacePackages,
  });
  return {
    checkers: options.checkers,
    config: options.config,
    configToOutputBuildByChecker: options.configToOutputBuildByChecker,
    diagnostics: packageBuildScripts.diagnostics.map(toPackageScriptDiagnostic),
    scriptsByPackageName: groupScriptsByPackageName(
      packageBuildScripts.scripts,
    ),
  };
}

export function prepareGeneratedKnipPackageConfigs(options: {
  checkers: ResolvedCheckerConfig[];
  configToOutputBuildByChecker: Map<string, Map<string, GeneratedBuildModule>>;
  config: ResolvedLiminaConfig;
  workspacePackages: WorkspacePackage[];
}): PreparedGeneratedKnipPackageConfigs {
  const context = createPrepareContext(options);
  const configs: PreparedGeneratedKnipPackageConfig[] = [];

  for (const workspacePackage of options.workspacePackages.filter(
    isNamedWorkspacePackage,
  )) {
    const prepared = preparePackageConfig(workspacePackage, context);

    if (prepared !== null) {
      configs.push(prepared);
    }
  }

  context.diagnostics.sort(compareDiagnostics);
  return {
    configs,
    diagnostics: context.diagnostics.map((diagnostic) =>
      toManifestRelativeDiagnostic(diagnostic, options.config.rootDir),
    ),
  };
}
