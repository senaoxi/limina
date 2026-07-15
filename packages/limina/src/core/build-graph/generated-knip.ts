import type {
  ResolvedCheckerConfig,
  ResolvedLiminaConfig,
} from '#config/runner';
import type { GeneratedBuildModule } from '#core/build-graph/runner';
import type { WorkspacePackage } from '#core/workspace/actions';
import { isNamedWorkspacePackage } from '#core/workspace/actions';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  toPosixPath,
  toRelativePath,
} from '#utils/path';
import { existsSync, statSync } from 'node:fs';
import path from 'pathe';
import { createExternalArtifactStableId } from '../../domain/artifacts/namespace';
import {
  collectPackageBuildScripts,
  type PackageBuildScript,
  type PackageBuildScriptDiagnostic,
} from '../packages/build-scripts';

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

function getGeneratedKnipConfigPath(options: {
  packageDirectory: string;
  rootDir: string;
}): string {
  const relativePackageDirectory = toRelativePath(
    options.rootDir,
    options.packageDirectory,
  );
  const relativeOutputPath =
    relativePackageDirectory === '.'
      ? path.join('.limina/knip', 'tsconfig.knip.json')
      : relativePackageDirectory === '..' ||
          relativePackageDirectory.startsWith(`..${path.sep}`)
        ? path.join(
            '.limina/knip/external',
            createExternalArtifactStableId(
              toPosixPath(relativePackageDirectory),
            ),
            'tsconfig.knip.json',
          )
        : path.join(
            '.limina/knip',
            relativePackageDirectory,
            'tsconfig.knip.json',
          );

  return normalizeAbsolutePath(path.join(options.rootDir, relativeOutputPath));
}

function resolveManagedBuildConfigPaths(options: {
  checkers: ResolvedCheckerConfig[];
  configToOutputBuildByChecker: Map<string, Map<string, GeneratedBuildModule>>;
  script: PackageBuildScript;
}): string[] {
  const configPaths = new Set<string>();

  for (const checker of options.checkers) {
    if (options.script.checker && checker.preset !== options.script.checker) {
      continue;
    }

    const outputModule = options.configToOutputBuildByChecker
      .get(checker.name)
      ?.get(options.script.configPath);

    if (outputModule) {
      configPaths.add(outputModule.path);
    }
  }

  return [...configPaths].sort((left, right) => left.localeCompare(right));
}

function toPackageScriptDiagnostic(
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

function validatePackageBuildScript(options: {
  config: ResolvedLiminaConfig;
  mode: GeneratedKnipPackageBuildMode;
  script: PackageBuildScript;
  workspacePackage: WorkspacePackage;
}): GeneratedKnipPackageDiagnostic | null {
  const configPath = options.script.configPath;

  if (!existsSync(configPath)) {
    return {
      command: options.script.command,
      packageJsonPath: options.script.packageJsonPath,
      packageName: options.script.packageName,
      reason: `build config does not exist: ${toRelativePath(options.config.rootDir, configPath)}`,
      scriptName: options.script.name,
    };
  }

  if (statSync(configPath).isDirectory()) {
    return {
      command: options.script.command,
      packageJsonPath: options.script.packageJsonPath,
      packageName: options.script.packageName,
      reason: `build config must be a JSON file, not a directory: ${toRelativePath(options.config.rootDir, configPath)}`,
      scriptName: options.script.name,
    };
  }

  if (!configPath.endsWith('.json')) {
    return {
      command: options.script.command,
      packageJsonPath: options.script.packageJsonPath,
      packageName: options.script.packageName,
      reason: `build config must be a JSON file: ${toRelativePath(options.config.rootDir, configPath)}`,
      scriptName: options.script.name,
    };
  }

  if (configPath.split(path.sep).includes('.limina')) {
    return {
      command: options.script.command,
      packageJsonPath: options.script.packageJsonPath,
      packageName: options.script.packageName,
      reason:
        'build config must not point at .limina generated configs; use the source config in package scripts.',
      scriptName: options.script.name,
    };
  }

  if (
    options.mode === 'raw' &&
    !isPathInsideDirectory(configPath, options.workspacePackage.directory)
  ) {
    return {
      command: options.script.command,
      packageJsonPath: options.script.packageJsonPath,
      packageName: options.script.packageName,
      reason:
        'raw build configs from package scripts must resolve inside the owning package directory.',
      scriptName: options.script.name,
    };
  }

  return null;
}

function createGeneratedKnipContent(options: {
  configPath: string;
  references: string[];
}): PreparedGeneratedKnipPackageConfig['content'] {
  return {
    files: [],
    references: options.references.map((referencePath) => ({
      path: toPosixPath(
        path.relative(path.dirname(options.configPath), referencePath),
      ),
    })),
  };
}

function toManifestRelativePackageConfig(options: {
  config: GeneratedKnipPackageConfig;
  rootDir: string;
}): GeneratedKnipPackageConfig {
  return {
    ...options.config,
    configPath: toPosixPath(
      toRelativePath(options.rootDir, options.config.configPath),
    ),
    packageDirectory: toPosixPath(
      toRelativePath(options.rootDir, options.config.packageDirectory),
    ),
    packageJsonPath: toPosixPath(
      toRelativePath(options.rootDir, options.config.packageJsonPath),
    ),
    references: options.config.references.map((reference) =>
      toPosixPath(toRelativePath(options.rootDir, reference)),
    ),
    scripts: options.config.scripts.map((script) => ({
      ...script,
      configPath: toPosixPath(
        toRelativePath(options.rootDir, script.configPath),
      ),
    })),
  };
}

export function resolveGeneratedKnipPackageConfigs(options: {
  configs: GeneratedKnipPackageConfig[];
  rootDir: string;
}): GeneratedKnipPackageConfig[] {
  return options.configs.map((config) => ({
    ...config,
    configPath: normalizeAbsolutePath(
      path.join(options.rootDir, config.configPath),
    ),
    packageDirectory: normalizeAbsolutePath(
      path.join(options.rootDir, config.packageDirectory),
    ),
    packageJsonPath: normalizeAbsolutePath(
      path.join(options.rootDir, config.packageJsonPath),
    ),
    references: config.references.map((reference) =>
      normalizeAbsolutePath(path.join(options.rootDir, reference)),
    ),
    scripts: config.scripts.map((script) => ({
      ...script,
      configPath: normalizeAbsolutePath(
        path.join(options.rootDir, script.configPath),
      ),
    })),
  }));
}

export function resolveGeneratedKnipPackageDiagnostics(options: {
  diagnostics: GeneratedKnipPackageDiagnostic[];
  rootDir: string;
}): GeneratedKnipPackageDiagnostic[] {
  return options.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    packageJsonPath: normalizeAbsolutePath(
      path.join(options.rootDir, diagnostic.packageJsonPath),
    ),
  }));
}

export function prepareGeneratedKnipPackageConfigs(options: {
  checkers: ResolvedCheckerConfig[];
  configToOutputBuildByChecker: Map<string, Map<string, GeneratedBuildModule>>;
  config: ResolvedLiminaConfig;
  workspacePackages: WorkspacePackage[];
}): PreparedGeneratedKnipPackageConfigs {
  const diagnostics: GeneratedKnipPackageDiagnostic[] = [];
  const packageBuildScripts = collectPackageBuildScripts({
    config: options.config,
    workspacePackages: options.workspacePackages,
  });
  const scriptsByPackageName = new Map<string, PackageBuildScript[]>();

  diagnostics.push(
    ...packageBuildScripts.diagnostics.map(toPackageScriptDiagnostic),
  );

  for (const script of packageBuildScripts.scripts) {
    scriptsByPackageName.set(script.packageName, [
      ...(scriptsByPackageName.get(script.packageName) ?? []),
      script,
    ]);
  }

  const configs: PreparedGeneratedKnipPackageConfig[] = [];

  for (const workspacePackage of options.workspacePackages.filter(
    isNamedWorkspacePackage,
  )) {
    const packageScripts =
      scriptsByPackageName.get(workspacePackage.name) ?? [];
    const references = new Set<string>();
    const scripts: GeneratedKnipPackageBuildScript[] = [];

    for (const script of packageScripts) {
      const managedConfigPaths = script.raw
        ? []
        : resolveManagedBuildConfigPaths({
            checkers: options.checkers,
            configToOutputBuildByChecker: options.configToOutputBuildByChecker,
            script,
          });
      const mode: GeneratedKnipPackageBuildMode = script.raw
        ? 'raw'
        : 'managed';
      const diagnostic = validatePackageBuildScript({
        config: options.config,
        mode,
        script,
        workspacePackage,
      });

      if (diagnostic) {
        diagnostics.push(diagnostic);
        continue;
      }

      if (!script.raw && managedConfigPaths.length === 0) {
        diagnostics.push({
          command: script.command,
          packageJsonPath: script.packageJsonPath,
          packageName: script.packageName,
          reason:
            'managed limina build package scripts must point to a Limina-managed config with liminaOptions.outputs.',
          scriptName: script.name,
        });
        continue;
      }

      for (const referencePath of script.raw
        ? [script.configPath]
        : managedConfigPaths) {
        references.add(referencePath);
      }
      scripts.push({
        ...(script.checker ? { checker: script.checker } : {}),
        command: script.command,
        configPath: script.configPath,
        mode,
        name: script.name,
      });
    }

    if (references.size === 0) {
      continue;
    }

    const configPath = getGeneratedKnipConfigPath({
      packageDirectory: workspacePackage.directory,
      rootDir: options.config.rootDir,
    });
    const config: GeneratedKnipPackageConfig = {
      configPath,
      packageDirectory: workspacePackage.directory,
      packageJsonPath: normalizeAbsolutePath(
        path.join(workspacePackage.directory, 'package.json'),
      ),
      packageName: workspacePackage.name,
      references: [...references].sort(),
      scripts: scripts.sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    };

    configs.push({
      config: toManifestRelativePackageConfig({
        config,
        rootDir: options.config.rootDir,
      }),
      configPath,
      content: createGeneratedKnipContent({
        configPath,
        references: config.references,
      }),
    });
  }

  diagnostics.sort(
    (left, right) =>
      left.packageJsonPath.localeCompare(right.packageJsonPath) ||
      (left.scriptName ?? '').localeCompare(right.scriptName ?? ''),
  );

  return {
    configs,
    diagnostics: diagnostics.map((diagnostic) => ({
      ...diagnostic,
      packageJsonPath: toPosixPath(
        toRelativePath(options.config.rootDir, diagnostic.packageJsonPath),
      ),
    })),
  };
}
