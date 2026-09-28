import type { ResolvedLiminaConfig } from '#config/runner';
import ts from 'typescript';
import { parseTypeScriptCommandLine } from '../../../checker/project-base';

export function readExplicitSourceCompilerTarget(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
}): string | null {
  const { parsed } = parseTypeScriptCommandLine({
    parseOptions: {
      allowNoInputDiagnostics: true,
      configPath: options.configPath,
      projectRootDir: options.config.rootDir,
    },
  });
  const target = parsed.options.target;
  if (target === undefined) return null;
  return target === ts.ScriptTarget.ESNext ? 'ESNext' : ts.ScriptTarget[target];
}
