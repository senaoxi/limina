import type ts from 'typescript';
import type { ImportRecord } from '../import-analysis/records';
import { getCompilerReferenceForModuleQuery } from '../typescript-semantic/reference-redirect';
import { originTracingCompiler } from '../typescript-semantic/resolution-origin';
import { runtimeModuleResolutionMode } from '../typescript-semantic/runtime-module-queries';
import type { FrameworkRuntimeModuleResult } from './runtime-dependencies';

type VolarModuleResolver = NonNullable<
  ts.LanguageServiceHost['resolveModuleNameLiterals']
>;

interface RuntimeQuery {
  literal: ts.StringLiteralLike;
  occurrence: ImportRecord;
  observation?: { mode: ts.ResolutionMode };
}

/**
 * Ask the same Volar host, after its component-specific format fixup.
 */
export function createVolarRuntimeResolution(compiler: typeof ts): {
  compiler: typeof ts;
  resolve(
    resolver: VolarModuleResolver | undefined,
    program: ts.Program,
    source: ts.SourceFile,
    literal: ts.StringLiteralLike,
    occurrence: ImportRecord,
  ): FrameworkRuntimeModuleResult;
} {
  let active: RuntimeQuery | undefined;
  const facade = originTracingCompiler(compiler);
  Object.defineProperty(facade, 'getModeForUsageLocation', {
    value: (
      source: ts.SourceFile,
      literal: ts.StringLiteralLike,
      options: ts.CompilerOptions,
    ): ts.ResolutionMode => {
      if (active === undefined || active.literal !== literal)
        return compiler.getModeForUsageLocation(source, literal, options);
      const mode = runtimeModuleResolutionMode({
        compiler,
        source,
        literal,
        options,
        occurrence: active.occurrence,
      });
      active.observation = { mode };
      return mode;
    },
  });
  return {
    compiler: facade,
    resolve(resolver, program, source, literal, occurrence) {
      const redirect = getCompilerReferenceForModuleQuery(
        program,
        source,
        compiler,
      );
      const query: RuntimeQuery = { literal, occurrence };
      const previous = active;
      active = query;
      try {
        const result = resolver?.(
          [literal],
          source.fileName,
          redirect,
          redirect?.commandLine.options ?? program.getCompilerOptions(),
          source,
          undefined,
        )[0];
        if (result === undefined || query.observation === undefined)
          throw new Error(
            'The bounded Volar host did not observe the runtime module query.',
          );
        return {
          mode: query.observation.mode,
          resolved: result.resolvedModule,
        };
      } finally {
        active = previous;
      }
    },
  };
}
