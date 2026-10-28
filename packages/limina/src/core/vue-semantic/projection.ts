import type ts from 'typescript';
import type {
  FrameworkSemanticCandidate,
  FrameworkSemanticDependencyPreparation,
} from '../framework-semantic/contracts';
import type { GeneratedSemanticDependency } from '../framework-semantic/generated-dependencies';
import { strictBackprojectVolarDependency } from '../framework-semantic/volar-backprojection';
import type { ImportRecord } from '../import-analysis/records';
import { collectVueCompilerSource } from './compiler-source';
import type { VueSemanticContext } from './context';
import type { VueServiceScriptPair } from './dependency';

export type VueCandidate = FrameworkSemanticCandidate<
  ts.SourceFile,
  ts.StringLiteralLike
>;

type ProjectionFailure = Extract<
  FrameworkSemanticDependencyPreparation,
  { kind: 'unsupported' }
>;

type ProjectionResult = ProjectionFailure | VueCandidate | null;

const SOURCE_ONLY_KINDS = new Set([
  'environment-pragma',
  'jsx-import-source',
  'triple-slash-path',
  'triple-slash-types',
]);

function createFailure(
  reason: string,
  stage: ProjectionFailure['stage'],
): ProjectionFailure {
  return { kind: 'unsupported', reason, stage };
}

function handleMappedProjection(options: {
  context: VueSemanticContext;
  dependency: GeneratedSemanticDependency;
  directSourceRecords: ImportRecord[];
  projection: Extract<
    ReturnType<typeof strictBackprojectVolarDependency>,
    { kind: 'mapped' }
  >;
  sourceFile: ts.SourceFile;
}): ProjectionResult {
  if (SOURCE_ONLY_KINDS.has(options.dependency.record.kind)) {
    options.directSourceRecords.push(options.projection.sourceRecord);
    return null;
  }
  if (options.dependency.literal === null) {
    return createFailure(
      'Vue generated dependency did not identify a TypeScript module literal.',
      'source-map-mismatch',
    );
  }
  return {
    containingSourceFile: options.sourceFile,
    framework: 'vue',
    identityId: options.context.identity.id,
    literal: options.dependency.literal,
    provenance: 'strict-source-map',
    semanticSpecifier: options.dependency.record.specifier,
    sourceRecord: options.projection.sourceRecord,
  };
}

function handleNonUnmappedProjection(options: {
  context: VueSemanticContext;
  dependency: GeneratedSemanticDependency;
  directSourceRecords: ImportRecord[];
  projection: Exclude<
    ReturnType<typeof strictBackprojectVolarDependency>,
    { kind: 'unmapped' }
  >;
  sourceFile: ts.SourceFile;
}): ProjectionResult {
  if (options.projection.kind === 'source-map-ambiguity') {
    return createFailure(
      'Vue generated dependency strictly projected to multiple source ranges.',
      'source-map-ambiguity',
    );
  }
  return options.projection.kind === 'source-map-mismatch'
    ? createFailure(options.projection.reason, 'source-map-mismatch')
    : handleMappedProjection({ ...options, projection: options.projection });
}

function projectDependency(options: {
  context: VueSemanticContext;
  dependency: GeneratedSemanticDependency;
  directSourceRecords: ImportRecord[];
  filePath: string;
  mapper: Parameters<typeof strictBackprojectVolarDependency>[0]['mapper'];
  sourceFile: ts.SourceFile;
  sourceText: string;
  unmapped: Extract<
    FrameworkSemanticDependencyPreparation,
    { kind: 'supported' }
  >['unmapped'];
}): ProjectionResult {
  if (options.dependency.literal !== null && options.dependency.literal.pos < 0)
    return compilerRequestCandidate(options);
  const projection = strictBackprojectVolarDependency({
    dependency: options.dependency,
    mapper: options.mapper,
    sourceFilePath: options.filePath,
    sourceText: options.sourceText,
  });
  if (projection.kind !== 'unmapped') {
    return handleNonUnmappedProjection({ ...options, projection });
  }
  if (options.dependency.record.compilerRequest !== undefined)
    return compilerRequestCandidate(options);
  options.unmapped.push({
    generatedFilePath: options.dependency.generatedFilePath,
    semanticSpecifier: options.dependency.record.specifier,
  });
  return null;
}

function appendProjection(
  candidates: VueCandidate[],
  projected: ProjectionResult,
): ProjectionFailure | null {
  if (projected === null) return null;
  if ('kind' in projected) return projected;
  candidates.push(projected);
  return null;
}

export function collectVueMappedCandidates(options: {
  context: VueSemanticContext;
  directSourceRecords: ImportRecord[];
  filePath: string;
  service: VueServiceScriptPair;
  sourceFile: ts.SourceFile;
  sourceText: string;
  unmapped: Extract<
    FrameworkSemanticDependencyPreparation,
    { kind: 'supported' }
  >['unmapped'];
}): ProjectionFailure | { candidates: VueCandidate[]; kind: 'supported' } {
  const mapper = options.context.language.maps.get(
    options.service.serviceScript.code,
    options.service.sourceScript,
  );
  const dependencies: GeneratedSemanticDependency[] = [
    ...options.context.compilerRequests.collect(
      options.context.program,
      options.sourceFile,
    ),
    ...(
      collectVueCompilerSource(options.context, options.sourceFile.fileName) ??
      []
    )
      .filter((record) =>
        ['triple-slash-path', 'triple-slash-types'].includes(record.kind),
      )
      .map((record) => ({
        record,
        literal: null,
        sourceFile: options.sourceFile,
        generatedFilePath: options.sourceFile.fileName,
      })),
  ];
  const candidates: VueCandidate[] = [];
  for (const dependency of dependencies) {
    const failure = appendProjection(
      candidates,
      projectDependency({ ...options, dependency, mapper }),
    );
    if (failure !== null) return failure;
  }
  return { candidates, kind: 'supported' };
}

function compilerRequestCandidate(options: {
  context: VueSemanticContext;
  dependency: GeneratedSemanticDependency;
  filePath: string;
}): ProjectionResult {
  const { dependency, context } = options;
  if (
    dependency.literal === null ||
    dependency.record.compilerRequest === undefined
  )
    return createFailure(
      'Vue generated dependency has no bound compiler request.',
      'source-map-mismatch',
    );
  return {
    containingSourceFile: dependency.sourceFile,
    framework: 'vue',
    identityId: context.identity.id,
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
