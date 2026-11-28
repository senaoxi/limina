import type ts from 'typescript';
import type { ImportRecord } from '../import-analysis/records';

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
