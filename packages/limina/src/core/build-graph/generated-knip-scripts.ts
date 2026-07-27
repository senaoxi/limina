import type {
  ResolvedCheckerConfig,
  ResolvedLiminaConfig,
} from '#config/runner';
import type { GeneratedBuildModule } from '#core/build-graph/runner';
import type { WorkspacePackage } from '#core/workspace/actions';
import { isPathInsideDirectory, toRelativePath } from '#utils/path';
import { existsSync, statSync } from 'node:fs';
import path from 'pathe';
import type {
  PackageBuildScript,
  PackageBuildScriptDiagnostic,
} from '../packages/build-scripts';
import type {
  GeneratedKnipPackageBuildMode,
  GeneratedKnipPackageBuildScript,
  GeneratedKnipPackageDiagnostic,
} from './generated-knip-types';

interface BuildScriptValidationContext {
  config: ResolvedLiminaConfig;
  mode: GeneratedKnipPackageBuildMode;
  script: PackageBuildScript;
  workspacePackage: WorkspacePackage;
}

type BuildScriptValidator = (
  context: BuildScriptValidationContext,
) => string | null;

export interface PreparedKnipBuildScript {
  references: string[];
  script: GeneratedKnipPackageBuildScript;
}

export function toPackageScriptDiagnostic(
  diagnostic: PackageBuildScriptDiagnostic,
): GeneratedKnipPackageDiagnostic {
  return {
    command: diagnostic.command,
    packageJsonPath: diagnostic.packageJsonPath,
    packageName: diagnostic.packageName,
    reason: diagnostic.reason,
    scriptName: diagnostic.scriptName,
  };
}

function checkerMatchesScript(
  checker: ResolvedCheckerConfig,
  script: PackageBuildScript,
): boolean {
  return script.checker === undefined || checker.preset === script.checker;
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

export function resolveManagedBuildConfigPaths(options: {
  checkers: ResolvedCheckerConfig[];
  configToOutputBuildByChecker: Map<string, Map<string, GeneratedBuildModule>>;
  script: PackageBuildScript;
}): string[] {
  return [
    ...new Set(
      options.checkers
        .filter((checker) => checkerMatchesScript(checker, options.script))
        .map((checker) =>
          getOutputModulePath({
            checker,
            configToOutputBuildByChecker: options.configToOutputBuildByChecker,
            script: options.script,
          }),
        )
        .filter((value): value is string => value !== undefined),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function createScriptDiagnostic(
  script: PackageBuildScript,
  reason: string,
): GeneratedKnipPackageDiagnostic {
  return {
    command: script.command,
    packageJsonPath: script.packageJsonPath,
    packageName: script.packageName,
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

const validateSourceConfig: BuildScriptValidator = ({ script }) =>
  script.configPath.split(path.sep).includes('.limina')
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

export function validatePackageBuildScript(
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
    ...(script.checker === undefined ? {} : { checker: script.checker }),
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

export function prepareKnipBuildScript(options: {
  checkers: ResolvedCheckerConfig[];
  config: ResolvedLiminaConfig;
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
