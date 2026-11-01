import type ts from 'typescript';
import type {
  FrameworkSemanticCandidate,
  FrameworkSemanticKind,
} from './contracts';
import type { GeneratedSemanticDependency } from './generated-dependencies';

export function compilerRequestCandidate(options: {
  dependency: GeneratedSemanticDependency;
  framework: FrameworkSemanticKind;
  identityId: string;
  filePath: string;
}):
  | FrameworkSemanticCandidate<ts.SourceFile, ts.StringLiteralLike>
  | undefined {
  const { dependency } = options;
  if (
    dependency.literal === null ||
    dependency.record.compilerRequest === undefined
  )
    return undefined;
  return {
    containingSourceFile: dependency.sourceFile,
    framework: options.framework,
    identityId: options.identityId,
    literal: dependency.literal,
    provenance: 'compiler-request',
    semanticSpecifier: dependency.record.specifier,
    sourceRecord: {
      ...dependency.record,
      filePath: options.filePath,
      line: 0,
      locator: { ...dependency.record.locator, sourceStart: -1, sourceEnd: -1 },
    },
  };
}
