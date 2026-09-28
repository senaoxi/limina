import type {
  PackageBuildScriptDiagnostic,
  PackageBuildScriptSource,
} from './build-script-types';

export function createBuildScriptDiagnostic(
  source: PackageBuildScriptSource,
  reason: string,
): PackageBuildScriptDiagnostic {
  return {
    command: source.command,
    packageJsonPath: source.packageJsonPath,
    packageName: source.packageName,
    reason,
    scriptName: source.scriptName,
  };
}
