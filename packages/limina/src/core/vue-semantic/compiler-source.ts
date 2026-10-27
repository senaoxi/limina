import type ts from 'typescript';
import type { ImportRecord } from '../import-analysis/records';
import type { VueSemanticContext } from './context';

export function collectVueCompilerSource(
  context: VueSemanticContext,
  file: string,
): ImportRecord[] | undefined {
  const source = context.program.getSourceFile(file);
  return source === undefined
    ? undefined
    : [
        ...context.compilerRequests
          .collect(context.program, source)
          .map((request) => request.record),
        ...directives(source, 'triple-slash-path', source.referencedFiles),
        ...directives(
          source,
          'triple-slash-types',
          source.typeReferenceDirectives,
        ),
      ];
}
function directives(
  source: ts.SourceFile,
  kind: ImportRecord['kind'],
  references: readonly ts.FileReference[],
): ImportRecord[] {
  return references.map((reference, occurrence) => ({
    domain: 'typescript',
    kind,
    filePath: source.fileName,
    specifier: reference.fileName,
    line: source.getLineAndCharacterOfPosition(reference.pos).line + 1,
    locator: {
      sourceStart: reference.pos - 1,
      sourceEnd: reference.end + 1,
      occurrence,
    },
  }));
}
