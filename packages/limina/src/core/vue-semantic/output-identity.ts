import type { VueProjectSemanticIdentity } from '#checkers';
import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import { createVueExtraFileExtensions } from '../../checker/vue-semantic-profiles';
import { analysisHash } from '../analysis-cache/identity';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import type { TypeScriptSemanticProject } from '../typescript-semantic/contracts';
import { parseTypeScriptProjectConfig } from '../typescript-semantic/project-references';
import { withVueDeclarationLoading } from './loading-identity';

export function parseVueOutputConfig(
  source: VueProjectSemanticIdentity,
  configPath: string,
  virtualFiles: ReadonlyMap<string, string>,
): ts.ParsedCommandLine | undefined {
  const tsModule = source.toolchain.tsModule;
  return parseTypeScriptProjectConfig({
    configPath,
    tsModule,
    virtualFiles,
    extraFileExtensions: createVueExtraFileExtensions({
      tsModule,
      extensions: source.extensions,
    }),
  });
}

type Output = Pick<
  TypeScriptSemanticProject,
  'configPath' | 'options' | 'fileNames' | 'projectReferences' | 'virtualFiles'
>;

function stagedConfigs(
  source: VueProjectSemanticIdentity,
  output: Output,
): Record<string, string> | undefined {
  const { virtualFiles, configPath } = output;
  const configFile = output.options.configFile as
    | ts.TsConfigSourceFile
    | undefined;
  if (!virtualFiles || configFile?.fileName !== configPath) return undefined;
  const configs: Record<string, string> = { [configPath]: configFile.text };
  const pending = [...(output.projectReferences ?? [])];
  while (pending.length > 0) {
    const reference = pending.pop()!;
    const file = normalizeAbsolutePath(
      source.toolchain.tsModule.resolveProjectReferencePath(reference),
    );
    if (Object.hasOwn(configs, file)) continue;
    const text = virtualFiles.get(file);
    if (text === undefined) return undefined;
    const parsed = parseVueOutputConfig(source, file, virtualFiles);
    if (parsed === undefined || parsed.errors.length > 0) return undefined;
    configs[file] = text;
    pending.push(...(parsed.projectReferences ?? []));
  }
  return configs;
}

export function createVueOutputIdentity(
  source: VueProjectSemanticIdentity,
  output: Output,
): VueProjectSemanticIdentity | undefined {
  const configs = stagedConfigs(source, output);
  if (configs === undefined) return undefined;
  const identity = {
    ...source,
    declarationBaseId: undefined,
    declarationLoading: undefined,
    outputProjection: { sourceConfigPath: source.configPath, configs },
    configPath: output.configPath,
    options: output.options,
    fileNames: output.fileNames,
    projectReferences: output.projectReferences,
    id: analysisHash([
      source.declarationBaseId ?? source.id,
      configs,
      output.configPath,
      effectiveCompilerOptions(output.options),
      output.fileNames,
      output.projectReferences,
    ]),
  };
  return source.declarationLoading === undefined
    ? identity
    : withVueDeclarationLoading(identity, source.declarationLoading);
}

export function vueProjectConfigFiles(
  identity: VueProjectSemanticIdentity,
): ReadonlyMap<string, string> {
  return identity.outputProjection === undefined
    ? identity.virtualFiles
    : new Map([
        ...identity.virtualFiles,
        ...Object.entries(identity.outputProjection.configs),
      ]);
}
