import path from 'node:path';
import type ts from 'typescript';
import {
  createFormatHost,
  createProjectParseHost,
  parseWithObservedConfigInputs,
  TypeScriptConfigInputError,
} from './project-base';
import {
  projectResolvedConfig,
  type ResolvedConfigProjection,
} from './resolved-config';

export function parseFrameworkProjectConfig(input: {
  configPath: string;
  extraFileExtensions: readonly ts.FileExtensionInfo[];
  tsModule: typeof ts;
  virtualFiles?: ReadonlyMap<string, string>;
}): ResolvedConfigProjection {
  const { configPath, tsModule } = input;
  const directory = path.dirname(configPath);
  const content = new Map<string, string>();
  const rootSelectors: Parameters<typeof ts.sys.readDirectory>[] = [];
  const host = createProjectParseHost(input.virtualFiles, content, tsModule, {
    rootSelectors,
  });
  const text = host.readFile(configPath);
  if (text === undefined)
    throw new Error(`Framework source config is unreadable: ${configPath}`);
  const cache = new Map<string, ts.ExtendedConfigCacheEntry>();
  const parsed = parseWithObservedConfigInputs(host, (parseHost) =>
    tsModule.parseJsonSourceFileConfigFileContent(
      tsModule.parseJsonText(configPath, text),
      parseHost,
      directory,
      undefined,
      configPath,
      undefined,
      input.extraFileExtensions,
      cache,
    ),
  );
  const errors = parsed.errors.filter(
    ({ code }) => code !== 18_002 && code !== 18_003,
  );
  if (errors.length > 0)
    throw new TypeScriptConfigInputError(
      tsModule.formatDiagnosticsWithColorAndContext(
        errors,
        createFormatHost(directory),
      ),
    );
  return projectResolvedConfig(
    configPath,
    parsed,
    cache,
    content,
    rootSelectors,
  );
}
