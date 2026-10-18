import path from 'pathe';
import type ts from 'typescript';
import type { DeclarationEntry } from './declaration-closure';
import {
  getResolutionOrigin,
  resolveTypeWithOrigin,
} from './resolution-origin';

export function collectTypeEnvironmentEntries(input: {
  compiler: typeof ts;
  options: ts.CompilerOptions;
  host: ts.ModuleResolutionHost;
  configPath: string;
}): DeclarationEntry[] {
  const { compiler, options, host, configPath } = input;
  const from = path.join(
    path.dirname(configPath),
    '__inferred type names__.ts',
  );
  return compiler
    .getAutomaticTypeDirectiveNames(options, host)
    .flatMap((name) => {
      const target = resolveTypeWithOrigin(
        compiler,
        name,
        from,
        options,
        host,
      ).resolvedTypeReferenceDirective;
      return target?.resolvedFileName === undefined
        ? []
        : [
            {
              kind: 'type-environment' as const,
              name,
              fileName: target.resolvedFileName,
              origin: getResolutionOrigin(target),
            },
          ];
    });
}

export function collectFrameworkEnvironmentEntries(input: {
  compiler: typeof ts;
  host: ts.ModuleResolutionHost;
  rootNames: readonly string[];
  scriptNames: readonly string[];
}): DeclarationEntry[] {
  const roots = new Set(input.rootNames);
  return input.scriptNames
    .filter((file) => !roots.has(file))
    .filter((file) => /\.d\.[cm]?ts$/.test(file))
    .filter((file) => input.host.fileExists(file))
    .map((fileName) => ({
      kind: 'framework-environment',
      fileName,
      origin: {
        version: 1,
        compiler: input.compiler.version,
        route: 'type-root',
        target: fileName,
      },
    }));
}
