import type { ResolvedLiminaConfig } from '#config/runner';
import type { WorkspacePackage } from '#core/workspace/actions';
import { isNamedWorkspacePackage } from '#core/workspace/actions';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import path from 'pathe';
import { parsePackageBuildScript } from './build-script-parser';
import type {
  PackageBuildScript,
  PackageBuildScriptCollection,
  PackageBuildScriptDiagnostic,
  PackageBuildScriptSource,
} from './build-script-types';

export type {
  PackageBuildScript,
  PackageBuildScriptCollection,
  PackageBuildScriptDiagnostic,
} from './build-script-types';

function collectScriptEntries(
  workspacePackage: WorkspacePackage,
): [string, string][] {
  return Object.entries(workspacePackage.manifest.scripts ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .sort(([left], [right]) => left.localeCompare(right));
}

function createScriptSource(options: {
  command: string;
  packageJsonPath: string;
  scriptName: string;
  workspacePackage: WorkspacePackage & { name: string };
}): PackageBuildScriptSource {
  return {
    command: options.command,
    packageDirectory: options.workspacePackage.directory,
    packageJsonPath: options.packageJsonPath,
    packageName: options.workspacePackage.name,
    scriptName: options.scriptName,
  };
}

function appendParsedScript(
  collection: PackageBuildScriptCollection,
  parsed: PackageBuildScript | PackageBuildScriptDiagnostic | null,
): void {
  if (parsed === null) {
    return;
  }

  if ('reason' in parsed) {
    collection.diagnostics.push(parsed);
    return;
  }

  collection.scripts.push(parsed);
}

function collectWorkspacePackageScripts(
  collection: PackageBuildScriptCollection,
  workspacePackage: WorkspacePackage,
): void {
  if (!isNamedWorkspacePackage(workspacePackage)) {
    return;
  }

  const packageJsonPath = normalizeAbsolutePath(
    path.join(workspacePackage.directory, 'package.json'),
  );

  for (const [scriptName, command] of collectScriptEntries(workspacePackage)) {
    appendParsedScript(
      collection,
      parsePackageBuildScript(
        createScriptSource({
          command,
          packageJsonPath,
          scriptName,
          workspacePackage,
        }),
      ),
    );
  }
}

function compareDiagnostics(
  left: PackageBuildScriptDiagnostic,
  right: PackageBuildScriptDiagnostic,
): number {
  return (
    left.packageJsonPath.localeCompare(right.packageJsonPath) ||
    left.scriptName.localeCompare(right.scriptName)
  );
}

function compareScripts(
  rootDir: string,
  left: PackageBuildScript,
  right: PackageBuildScript,
): number {
  const packageComparison = toRelativePath(
    rootDir,
    left.packageJsonPath,
  ).localeCompare(toRelativePath(rootDir, right.packageJsonPath));

  return packageComparison || left.name.localeCompare(right.name);
}

function sortCollection(
  config: ResolvedLiminaConfig,
  collection: PackageBuildScriptCollection,
): PackageBuildScriptCollection {
  collection.diagnostics.sort(compareDiagnostics);
  collection.scripts.sort((left, right) =>
    compareScripts(config.rootDir, left, right),
  );
  return collection;
}

export function collectPackageBuildScripts(options: {
  config: ResolvedLiminaConfig;
  workspacePackages: WorkspacePackage[];
}): PackageBuildScriptCollection {
  const collection: PackageBuildScriptCollection = {
    diagnostics: [],
    scripts: [],
  };

  for (const workspacePackage of options.workspacePackages) {
    collectWorkspacePackageScripts(collection, workspacePackage);
  }

  return sortCollection(options.config, collection);
}
