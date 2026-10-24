import type {
  ResolvedCheckerConfig,
  ResolvedLiminaInputs,
} from '#config/runner';
import type { GeneratedBuildModule } from '#core/build-graph/runner';
import { isLiminaArtifactPath } from '#core/tsconfig/actions';
import type { WorkspacePackage } from '#core/workspace/actions';
import { compareCodeUnits } from '#utils/collections';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  toRelativePath,
} from '#utils/path';
import { existsSync, statSync } from 'node:fs';
import path from 'pathe';
import {
  collectPackageBuildScripts,
  type PackageBuildScript,
  type PackageBuildScriptDiagnostic,
} from '../packages/build-scripts';
import {
  getPackageOwnerIdentity,
  type PackageOwnerIdentity,
} from '../workspace/owner-identity';
import type { ValidatedWorkspaceContext } from '../workspace/validated-context';
import {
  createGeneratedKnipContent,
  getGeneratedKnipConfigPath,
  toManifestRelativeDiagnostic,
  toManifestRelativePackageConfig,
} from './generated-knip-paths';

export type GeneratedKnipPackageBuildMode = 'managed' | 'raw';

export interface GeneratedKnipPackageBuildScript {
  checker?: 'tsc' | 'vue-tsc' | 'tsgo';
  command: string;
  configPath: string;
  mode: GeneratedKnipPackageBuildMode;
  name: string;
}

export interface GeneratedKnipPackageConfig {
  configPath: string;
  packageDirectory: string;
  packageJsonPath: string;
  packageName: string | null;
  references: string[];
  scripts: GeneratedKnipPackageBuildScript[];
}

export interface GeneratedKnipPackageDiagnostic {
  command?: string;
  packageJsonPath: string;
  packageName: string | null;
  reason: string;
  scriptName?: string;
}

export interface PreparedGeneratedKnipPackageConfig {
  config: GeneratedKnipPackageConfig;
  configPath: string;
  content: {
    files: [];
    references: { path: string }[];
  };
}

export interface PreparedGeneratedKnipPackageConfigs {
  configs: PreparedGeneratedKnipPackageConfig[];
  diagnostics: GeneratedKnipPackageDiagnostic[];
}

interface BuildScriptValidationContext {
  config: ResolvedLiminaInputs;
  mode: GeneratedKnipPackageBuildMode;
  script: PackageBuildScript;
  workspacePackage: WorkspacePackage;
}

type BuildScriptValidator = (
  context: BuildScriptValidationContext,
) => string | null;

interface PreparedKnipBuildScript {
  references: string[];
  script: GeneratedKnipPackageBuildScript;
}

function toPackageScriptDiagnostic(
  diagnostic: PackageBuildScriptDiagnostic,
): GeneratedKnipPackageDiagnostic {
  return {
    command: diagnostic.command,
    packageJsonPath: diagnostic.packageJsonPath,
    packageName: diagnostic.packageName ?? null,
    reason: diagnostic.reason,
    scriptName: diagnostic.scriptName,
  };
}

function isCheckerMatchesScript(
  checker: ResolvedCheckerConfig,
  script: PackageBuildScript,
): boolean {
  return script.checker === undefined || checker.name === script.checker;
}

function getOutputModulePath(options: {
  checker: ResolvedCheckerConfig;
  configToOutputBuildByChecker: Map<string, Map<string, GeneratedBuildModule>>;
  script: PackageBuildScript;
}): string | undefined {
  return options.configToOutputBuildByChecker
    .get(options.checker.name)
    ?.get(options.script.configPath)?.path;
}

function resolveManagedBuildConfigPaths(options: {
  checkers: ResolvedCheckerConfig[];
  configToOutputBuildByChecker: Map<string, Map<string, GeneratedBuildModule>>;
  script: PackageBuildScript;
}): string[] {
  return [
    ...new Set(
      options.checkers
        .filter((checker) => isCheckerMatchesScript(checker, options.script))
        .map((checker) =>
          getOutputModulePath({
            checker,
            configToOutputBuildByChecker: options.configToOutputBuildByChecker,
            script: options.script,
          }),
        )
        .filter((value): value is string => value !== undefined),
    ),
  ].sort(compareCodeUnits);
}

function createScriptDiagnostic(
  script: PackageBuildScript,
  reason: string,
): GeneratedKnipPackageDiagnostic {
  return {
    command: script.command,
    packageJsonPath: script.packageJsonPath,
    packageName: script.packageName ?? null,
    reason,
    scriptName: script.name,
  };
}

const validateExistingConfig: BuildScriptValidator = ({ config, script }) =>
  existsSync(script.configPath)
    ? null
    : `build config does not exist: ${toRelativePath(config.rootDir, script.configPath)}`;

const validateFileConfig: BuildScriptValidator = ({ config, script }) =>
  statSync(script.configPath).isDirectory()
    ? `build config must be a JSON file, not a directory: ${toRelativePath(config.rootDir, script.configPath)}`
    : null;

const validateJsonConfig: BuildScriptValidator = ({ config, script }) =>
  script.configPath.endsWith('.json')
    ? null
    : `build config must be a JSON file: ${toRelativePath(config.rootDir, script.configPath)}`;

const validateSourceConfig: BuildScriptValidator = ({ config, script }) =>
  isLiminaArtifactPath(script.configPath, config.rootDir)
    ? 'build config must not point at .limina generated configs; use the source config in package scripts.'
    : null;

const validateRawConfigOwnership: BuildScriptValidator = ({
  mode,
  script,
  workspacePackage,
}) => {
  if (mode !== 'raw') {
    return null;
  }

  return isPathInsideDirectory(script.configPath, workspacePackage.directory)
    ? null
    : 'raw build configs from package scripts must resolve inside the owning package directory.';
};

const buildScriptValidators: readonly BuildScriptValidator[] = [
  validateExistingConfig,
  validateFileConfig,
  validateJsonConfig,
  validateSourceConfig,
  validateRawConfigOwnership,
];

function validatePackageBuildScript(
  context: BuildScriptValidationContext,
): GeneratedKnipPackageDiagnostic | null {
  for (const validate of buildScriptValidators) {
    const reason = validate(context);

    if (reason !== null) {
      return createScriptDiagnostic(context.script, reason);
    }
  }

  return null;
}

function resolveBuildMode(
  script: PackageBuildScript,
): GeneratedKnipPackageBuildMode {
  return script.raw ? 'raw' : 'managed';
}

function createManagedReferenceDiagnostic(
  script: PackageBuildScript,
): GeneratedKnipPackageDiagnostic {
  return createScriptDiagnostic(
    script,
    'managed limina build package scripts must point to a Limina-managed config with liminaOptions.outputs.',
  );
}

function validateManagedReferences(
  script: PackageBuildScript,
  managedConfigPaths: readonly string[],
): GeneratedKnipPackageDiagnostic | null {
  if (script.raw) {
    return null;
  }

  return managedConfigPaths.length === 0
    ? createManagedReferenceDiagnostic(script)
    : null;
}

function resolveScriptReferences(
  script: PackageBuildScript,
  managedConfigPaths: string[],
): string[] {
  return script.raw ? [script.configPath] : managedConfigPaths;
}

function toGeneratedBuildScript(
  script: PackageBuildScript,
  mode: GeneratedKnipPackageBuildMode,
): GeneratedKnipPackageBuildScript {
  return {
    ...(script.checker !== undefined && { checker: script.checker }),
    command: script.command,
    configPath: script.configPath,
    mode,
    name: script.name,
  };
}

function resolveManagedPathsForScript(options: {
  checkers: ResolvedCheckerConfig[];
  configToOutputBuildByChecker: Map<string, Map<string, GeneratedBuildModule>>;
  script: PackageBuildScript;
}): string[] {
  return options.script.raw ? [] : resolveManagedBuildConfigPaths(options);
}

function finalizePreparedScript(options: {
  managedConfigPaths: string[];
  mode: GeneratedKnipPackageBuildMode;
  script: PackageBuildScript;
}): GeneratedKnipPackageDiagnostic | PreparedKnipBuildScript {
  const diagnostic = validateManagedReferences(
    options.script,
    options.managedConfigPaths,
  );

  if (diagnostic !== null) {
    return diagnostic;
  }

  return {
    references: resolveScriptReferences(
      options.script,
      options.managedConfigPaths,
    ),
    script: toGeneratedBuildScript(options.script, options.mode),
  };
}

function prepareKnipBuildScript(options: {
  checkers: ResolvedCheckerConfig[];
  config: ResolvedLiminaInputs;
  configToOutputBuildByChecker: Map<string, Map<string, GeneratedBuildModule>>;
  script: PackageBuildScript;
  workspacePackage: WorkspacePackage;
}): GeneratedKnipPackageDiagnostic | PreparedKnipBuildScript {
  const mode = resolveBuildMode(options.script);
  const managedConfigPaths = resolveManagedPathsForScript({
    checkers: options.checkers,
    configToOutputBuildByChecker: options.configToOutputBuildByChecker,
    script: options.script,
  });
  const diagnostic = validatePackageBuildScript({
    config: options.config,
    mode,
    script: options.script,
    workspacePackage: options.workspacePackage,
  });

  if (diagnostic !== null) {
    return diagnostic;
  }

  return finalizePreparedScript({
    managedConfigPaths,
    mode,
    script: options.script,
  });
}

interface PrepareContext {
  checkers: ResolvedCheckerConfig[];
  config: ResolvedLiminaInputs;
  configToOutputBuildByChecker: Map<string, Map<string, GeneratedBuildModule>>;
  diagnostics: GeneratedKnipPackageDiagnostic[];
  workspaceContext: ValidatedWorkspaceContext;
  scriptsByOwnerIdentity: ReadonlyMap<
    PackageOwnerIdentity,
    readonly PackageBuildScript[]
  >;
}

interface PackageScriptState {
  references: Set<string>;
  scripts: GeneratedKnipPackageBuildScript[];
}

function appendPackageScript(
  workspaceContext: ValidatedWorkspaceContext,
  scriptsByOwnerIdentity: Map<PackageOwnerIdentity, PackageBuildScript[]>,
  script: PackageBuildScript,
): void {
  const ownerIdentity = getPackageOwnerIdentity(
    workspaceContext,
    path.dirname(script.packageJsonPath),
  );
  const existing = scriptsByOwnerIdentity.get(ownerIdentity);

  if (existing === undefined) {
    scriptsByOwnerIdentity.set(ownerIdentity, [script]);
    return;
  }

  existing.push(script);
}

function groupScriptsByOwnerIdentity(
  scripts: readonly PackageBuildScript[],
  workspaceContext: ValidatedWorkspaceContext,
): Map<PackageOwnerIdentity, PackageBuildScript[]> {
  const scriptsByOwnerIdentity = new Map<
    PackageOwnerIdentity,
    PackageBuildScript[]
  >();

  for (const script of scripts) {
    appendPackageScript(workspaceContext, scriptsByOwnerIdentity, script);
  }

  return scriptsByOwnerIdentity;
}

function getPackageScripts(
  context: PrepareContext,
  workspacePackage: WorkspacePackage,
): readonly PackageBuildScript[] {
  const scripts = context.scriptsByOwnerIdentity.get(
    getPackageOwnerIdentity(
      context.workspaceContext,
      workspacePackage.directory,
    ),
  );
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
  workspacePackage: WorkspacePackage,
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
  workspacePackage: WorkspacePackage,
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
    packageName: workspacePackage.name ?? null,
    references: [...state.references].sort(compareCodeUnits),
    scripts: state.scripts.sort((left, right) =>
      compareCodeUnits(left.name, right.name),
    ),
  };
}

function preparePackageConfig(
  workspacePackage: WorkspacePackage,
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

  return pathOrder === 0
    ? compareCodeUnits(
        getDiagnosticScriptName(left),
        getDiagnosticScriptName(right),
      )
    : pathOrder;
}

function createPrepareContext(options: {
  checkers: ResolvedCheckerConfig[];
  config: ResolvedLiminaInputs;
  configToOutputBuildByChecker: Map<string, Map<string, GeneratedBuildModule>>;
  workspacePackages: WorkspacePackage[];
  workspaceContext: ValidatedWorkspaceContext;
}): PrepareContext {
  const packageBuildScripts = collectPackageBuildScripts({
    config: options.config,
    workspacePackages: options.workspacePackages,
  });
  return {
    workspaceContext: options.workspaceContext,
    checkers: options.checkers,
    config: options.config,
    configToOutputBuildByChecker: options.configToOutputBuildByChecker,
    diagnostics: packageBuildScripts.diagnostics.map(toPackageScriptDiagnostic),
    scriptsByOwnerIdentity: groupScriptsByOwnerIdentity(
      packageBuildScripts.scripts,
      options.workspaceContext,
    ),
  };
}

export function prepareGeneratedKnipPackageConfigs(options: {
  checkers: ResolvedCheckerConfig[];
  configToOutputBuildByChecker: Map<string, Map<string, GeneratedBuildModule>>;
  config: ResolvedLiminaInputs;
  workspacePackages: WorkspacePackage[];
  workspaceContext: ValidatedWorkspaceContext;
}): PreparedGeneratedKnipPackageConfigs {
  const context = createPrepareContext(options);
  const configs: PreparedGeneratedKnipPackageConfig[] = [];

  for (const workspacePackage of options.workspacePackages) {
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
