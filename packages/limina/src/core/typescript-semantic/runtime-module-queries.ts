import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import type { ResolutionQueryBinding } from '../analysis-cache/resolution-queries';
import type { ImportRecord } from '../import-analysis/records';
import { findImportRecordLiteral } from './import-record';
import { NativeObservationError } from './native-observation-failure';
import type { NativeProgramHost } from './native-program-host';
import { getCompilerReferenceForModuleQuery } from './reference-redirect';

export type NativeRuntimeModuleQuery = (
  occurrence: ImportRecord,
  explicitMode: ts.ResolutionMode,
) => ResolutionQueryBinding<NativeRuntimeModuleResult>;

export function createNativeRuntimeModuleQuery(
  compiler: typeof ts,
  program: ts.Program,
  host: NativeProgramHost,
  referenceConfigPaths: readonly string[],
): NativeRuntimeModuleQuery {
  const effective = program.getCompilerOptions();
  const configPaths = [
    ...new Set([
      ...((effective.configFile as ts.TsConfigSourceFile | undefined)
        ?.extendedSourceFiles ?? []),
      ...referenceConfigPaths,
    ]),
  ];
  return (occurrence, explicitMode) => {
    const source = program.getSourceFile(occurrence.filePath) as
      | (ts.SourceFile & { originalFileName?: string })
      | undefined;
    if (source === undefined)
      throw new NativeObservationError(
        'unsupported',
        `Bounded TypeScript Program did not admit ${occurrence.filePath}.`,
      );
    return {
      configPaths,
      formatManifests: (
        source as ts.SourceFile & { packageJsonLocations?: readonly string[] }
      ).packageJsonLocations,
      host,
      resolve(observedHost) {
        const redirect = getCompilerReferenceForModuleQuery(
          program,
          source,
          compiler,
          observedHost.realpath?.bind(observedHost),
        );
        const mode = runtimeModuleResolutionMode({
          compiler,
          explicitMode,
          occurrence,
          options: redirect?.commandLine.options ?? effective,
          source,
          literal:
            explicitMode === undefined &&
            !['commonjs', 'require-resolve'].includes(occurrence.kind)
              ? findImportRecordLiteral({
                  importRecord: occurrence,
                  sourceFile: source,
                  tsModule: compiler,
                })
              : undefined,
        });
        return {
          ...host.resolveRuntimeModule(
            {
              file: normalizeAbsolutePath(
                source.originalFileName ?? source.fileName,
              ),
              name: occurrence.specifier,
              mode,
              effective,
              redirect,
            },
            observedHost,
          ),
          runtimeMode: mode ?? null,
        };
      },
    };
  };
}

export function runtimeModuleResolutionMode(input: {
  compiler: typeof ts;
  source: ts.SourceFile;
  literal?: ts.StringLiteralLike | null;
  options: ts.CompilerOptions;
  occurrence: ImportRecord;
  explicitMode?: ts.ResolutionMode;
}): ts.ResolutionMode {
  const { compiler, source, literal, options, occurrence, explicitMode } =
    input;
  if (explicitMode !== undefined) return explicitMode;
  if (occurrence.kind === 'commonjs' || occurrence.kind === 'require-resolve') {
    // The compiler recognizes a bare require call. Ask the same mode worker
    // about that syntax for runtime forms it does not inventory.
    const argument = compiler.factory.createStringLiteral(occurrence.specifier);
    Object.assign(argument, {
      parent: compiler.factory.createCallExpression(
        compiler.factory.createIdentifier('require'),
        undefined,
        [argument],
      ),
    });
    return compiler.getModeForUsageLocation(source, argument, options);
  }
  return literal === null || literal === undefined
    ? undefined
    : compiler.getModeForUsageLocation(source, literal, options);
}

export interface NativeRuntimeModuleResult
  extends ts.ResolvedModuleWithFailedLookupLocations {
  readonly runtimeMode: ts.ResolutionMode | null;
}
